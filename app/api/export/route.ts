import { generateText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import { parseLlmJson } from "../../lib/parse-llm-json";
import type { ExportFileDescriptor, ExportFileFormat } from "../../lib/export";

const VALID_FORMATS: ExportFileFormat[] = ["code", "markdown", "docx", "pdf", "text"];

const SYSTEM_PROMPT = `你是文档导出助手。下面是一次用户与助手的对话。请判断：
1) 用户是否明确要求生成某个具体产物（例如：代码、报告、表格、文档、PDF、Word 文档、Markdown 文件等）？
   - 如果是：仅导出该产物相关的文件，最多 3 个版本（例如同一内容的 .py / .md / .docx 三种格式，或代码 + 说明文档两个文件）。
   - 如果否（即用户只是聊天、提问、咨询）：导出整段对话的 Markdown 摘要文件，以及一个 .docx 版本，共 2 个文件。
2) 文件内容必须可直接使用：代码文件里只放代码本身（不要包含"以下是代码"之类的解释），Markdown 文件可包含标题与正文，docx/pdf 的 content 字段放纯文本（客户端会按段落渲染）。

严格以 JSON 输出，不要任何解释文字、不要 Markdown 代码块包裹。JSON schema 如下：

{
  "files": [
    {
      "filename": "solution.py",
      "format": "code",
      "language": "python",
      "content": "def main():\n    pass\n"
    },
    {
      "filename": "report.docx",
      "format": "docx",
      "content": "一、背景\n...\n二、结论\n..."
    },
    {
      "filename": "summary.pdf",
      "format": "pdf",
      "content": "对话摘要\n..."
    }
  ]
}

format 取值：code | markdown | docx | pdf | text
- code：必须附带 language 字段（python / javascript / typescript / markdown / json / bash 等）。
- markdown：filename 以 .md 结尾。
- docx：filename 以 .docx 结尾，content 为纯文本，可用空行分段。
- pdf：filename 以 .pdf 结尾，content 为纯文本。
- text：filename 以 .txt 结尾。

files 数组长度必须为 1 到 3。再次强调：只输出 JSON，不要有任何其他字符。`;

type ExportMessage = { role: "user" | "assistant"; text: string };

function buildTranscript(messages: ExportMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
    .join("\n\n");
}

function validateFiles(raw: unknown): ExportFileDescriptor[] | null {
  if (!Array.isArray(raw)) return null;
  const valid: ExportFileDescriptor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const filename = typeof f.filename === "string" ? f.filename : undefined;
    const format = typeof f.format === "string" ? (f.format as ExportFileFormat) : undefined;
    const content = typeof f.content === "string" ? f.content : undefined;
    if (!filename || !format || !content) continue;
    if (!VALID_FORMATS.includes(format)) continue;
    const descriptor: ExportFileDescriptor = { filename, format, content };
    if (format === "code") {
      const language = typeof f.language === "string" ? f.language : "text";
      descriptor.language = language;
    }
    valid.push(descriptor);
    if (valid.length >= 3) break;
  }
  return valid.length > 0 ? valid : null;
}

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

  const transcript = buildTranscript(trimmed);

  try {
    const result = await generateText({
      model: chatClient.chat(CHAT_MODEL),
      system: SYSTEM_PROMPT,
      prompt: transcript,
    });
    const parsed = parseLlmJson<{ files: unknown }>(result.text);
    if (!parsed.ok) {
      return Response.json(
        { error: "model did not return valid JSON", raw: parsed.raw },
        { status: 422 },
      );
    }
    const files = validateFiles(parsed.value.files);
    if (!files) {
      return Response.json(
        { error: "no valid files in model output", raw: result.text },
        { status: 422 },
      );
    }
    return Response.json({ files });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "generateText failed" },
      { status: 500 },
    );
  }
}
