export class RequestBodyError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 同时限制 Content-Length 与真实流字节数，避免 chunked 请求绕过体积限制。 */
export async function readJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<T> {
  const length = declaredLength(request);
  if (length !== null && length > maxBytes) {
    throw new RequestBodyError("请求体过大", 413);
  }
  if (!request.body) throw new RequestBodyError("请求体必须是合法 JSON", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request body too large").catch(() => undefined);
      throw new RequestBodyError("请求体过大", 413);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined)) as T;
  } catch {
    throw new RequestBodyError("请求体必须是合法 JSON", 400);
  }
}
