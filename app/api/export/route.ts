/**
 * 导出文件 API 路由 —— HTTP 壳
 *
 * 核心逻辑（LLM 产物判断 + 文件校验）在 lib/services/export-generator.ts。
 */

import { generateExports } from "../../lib/services/export-generator";

export type ExportMessage = { role: "user" | "assistant"; text: string };

export async function POST(req: Request) {
  let body: { messages?: ExportMessage[] };
  try {
    body = (await req.json()) as { messages?: ExportMessage[] };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string",
  );
  if (messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  // 每条消息截到 20000 字，避免请求体过大
  const trimmed: ExportMessage[] = messages.map((m) => ({
    role: m.role,
    text: m.text.slice(0, 20000),
  }));

  try {
    const result = await generateExports(trimmed);
    if (!result.ok) {
      return Response.json(
        { error: result.reason === "invalid-json" ? "model did not return valid JSON" : "no valid files in model output", raw: result.raw },
        { status: 422 },
      );
    }
    return Response.json({ files: result.files });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "generateText failed" },
      { status: 500 },
    );
  }
}
