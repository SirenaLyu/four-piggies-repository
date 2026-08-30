/**
 * 为上游请求同时绑定调用方取消信号和本地超时。
 * 浏览器断开时立即取消；浏览器仍连接时则由 timeoutMs 兜底。
 */
export function withTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}
