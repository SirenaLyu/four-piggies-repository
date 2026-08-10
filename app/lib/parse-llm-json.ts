export type ParseLlmJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

/**
 * 防御性解析 LLM 返回的 JSON。
 * - 剥离前后空白
 * - 剥离 Markdown 代码块围栏（```json ... ``` 或 ``` ... ```）
 * - 找到第一个 { 到最后一个 } 之间的内容（兜底）
 * - 失败时返回 { ok: false, error, raw }
 */
export function parseLlmJson<T>(raw: string): ParseLlmJsonResult<T> {
  if (typeof raw !== "string") {
    return { ok: false, error: "raw is not a string", raw: String(raw) };
  }

  let text = raw.trim();

  // 剥离 ```json ... ``` 或 ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // 兜底：截取第一个 { 到最后一个 }
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1);
    }
  }

  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "JSON.parse failed",
      raw,
    };
  }
}
