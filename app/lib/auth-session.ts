import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { findUserById, getAuthSecrets, type AuthUser } from "./auth-store";

export const SESSION_COOKIE_NAME = "campus_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type SessionPayload = {
  userId: string;
  expiresAt: number;
};

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function signature(value: string): Promise<string> {
  const { sessionSecret } = await getAuthSecrets();
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

export async function createSessionToken(userId: string): Promise<string> {
  const payload: SessionPayload = {
    userId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${await signature(encoded)}`;
}

async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature) return null;
  const expected = Buffer.from(await signature(encoded));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (
      typeof payload.userId !== "string" ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function getAuthenticatedUser(request: Request): Promise<AuthUser | null> {
  const token = cookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const payload = await verifySessionToken(token);
  return payload ? findUserById(payload.userId) : null;
}

function secureCookieRequired(request: Request): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  const forwardedHttps =
    process.env.TRUST_PROXY_HEADERS?.trim().toLowerCase() === "true" &&
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return new URL(request.url).protocol === "https:" || forwardedHttps;
}

export function sessionCookie(token: string, request: Request): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secureCookieRequired(request) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function expiredSessionCookie(request: Request): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secureCookieRequired(request) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "请先登录" }, { status: 401 });
}
