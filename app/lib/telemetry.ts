import { randomUUID } from "node:crypto";

export type TelemetryContext = {
  requestId: string;
  scope: string;
};

type TelemetryValue = string | number | boolean | null | undefined;
type TelemetryFields = Record<string, TelemetryValue>;

const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{8,128}$/;

/** 接受可信格式的上游请求 ID，否则生成新的 ID，便于串联网关与应用日志。 */
export function requestIdFor(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim() ?? "";
  return SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export function createTelemetryContext(
  request: Request,
  scope: string,
): TelemetryContext {
  return { requestId: requestIdFor(request), scope };
}

/** 给客户端返回同一个请求 ID，方便截图或报错反馈时精确追踪。 */
export function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("X-Request-ID", requestId);
  return response;
}

/**
 * 输出单行 JSON，便于日志平台检索。调用方只传长度、数量和状态，
 * 不记录用户问题、附件正文、密钥或模型原始输出。
 */
export function logEvent(
  context: TelemetryContext,
  event: string,
  fields: TelemetryFields = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const details = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId: context.requestId,
    scope: context.scope,
    ...details,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
