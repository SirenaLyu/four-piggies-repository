type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export type ApiSecurityOptions = {
  scope:
    | "chat"
    | "export"
    | "summarize"
    | "auth"
    | "modelConfig"
    | "agentDirectory";
  defaultLimit: number;
  windowMs?: number;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_KEYS = 10_000;

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

function configuredOrigins(value = process.env.APP_ALLOWED_ORIGINS): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

function proxyHeadersTrusted(value = process.env.TRUST_PROXY_HEADERS): boolean {
  return value?.trim().toLowerCase() === "true";
}

/** 浏览器请求带 Origin 时必须来自当前 Host 或显式白名单。 */
export function isAllowedRequestOrigin(
  request: Request,
  allowedOrigins = configuredOrigins(),
  trustProxyHeaders = proxyHeadersTrusted(),
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized || normalized === "null") return false;
  if (allowedOrigins.has(normalized)) return true;

  const forwardedHost = trustProxyHeaders
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const host = forwardedHost || request.headers.get("host") || new URL(request.url).host;
  const forwardedProto = trustProxyHeaders
    ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    : undefined;
  const protocol = forwardedProto || new URL(request.url).protocol.replace(/:$/, "");
  return normalized === normalizeOrigin(`${protocol}://${host}`);
}

export function createFixedWindowRateLimiter(maxKeys = MAX_RATE_LIMIT_KEYS) {
  const entries = new Map<string, RateLimitEntry>();

  return (key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult => {
    const existing = entries.get(key);
    if (!existing || existing.resetAt <= now) {
      if (entries.size >= maxKeys) {
        for (const [candidate, entry] of entries) {
          if (entry.resetAt <= now || entries.size >= maxKeys) entries.delete(candidate);
          if (entries.size < maxKeys) break;
        }
      }
      const resetAt = now + windowMs;
      entries.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt };
    }

    existing.count += 1;
    entries.delete(key);
    entries.set(key, existing);
    return {
      allowed: existing.count <= limit,
      remaining: Math.max(0, limit - existing.count),
      resetAt: existing.resetAt,
    };
  };
}

const checkRateLimit = createFixedWindowRateLimiter();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function requestAddress(
  request: Request,
  trustProxyHeaders = proxyHeadersTrusted(),
): string {
  if (!trustProxyHeaders) return "direct-client";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    forwarded ||
    "unknown";
  return candidate.slice(0, 80);
}

export function guardApiRequest(
  request: Request,
  options: ApiSecurityOptions,
): Response | null {
  if (!isAllowedRequestOrigin(request)) {
    return Response.json({ error: "请求来源不受信任" }, { status: 403 });
  }

  const envSuffix = options.scope.toUpperCase();
  const limit = positiveInteger(
    process.env[`API_RATE_LIMIT_${envSuffix}`],
    options.defaultLimit,
  );
  const windowMs = positiveInteger(
    process.env.API_RATE_LIMIT_WINDOW_MS,
    options.windowMs ?? DEFAULT_WINDOW_MS,
  );
  const result = checkRateLimit(
    `${options.scope}:${requestAddress(request)}`,
    limit,
    windowMs,
  );
  if (result.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return Response.json(
    { error: "请求过于频繁，请稍后再试" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
