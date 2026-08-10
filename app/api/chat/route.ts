import { createClient } from "@supabase/supabase-js";
import { convertToModelMessages, createTextStreamResponse, embed, streamText } from "ai";
import { chatClient, embeddingClient, EMBEDDING_MODEL, CHAT_MODEL } from "../../lib/ai-clients";

// ===== Supabase 客户端 =====
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

// ===== 工具函数 =====

/**
 * 从消息中提取文本内容，兼容旧格式 { content } 和新格式 { parts: [{ type: "text", text }] }
 */
function extractMessageText(m: Record<string, unknown>): string {
  if (typeof m.content === "string" && m.content.length > 0) return m.content;
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

// ===== 向量搜索 =====

/**
 * 将用户提问转为向量，去 Supabase 做相似度搜索，返回匹配的文档内容
 */
async function searchRelevantDocuments(userQuery: string): Promise<string> {
  // 1. 用 embeddingClient 把问题转成向量
  const { embedding } = await embed({
    model: embeddingClient.embedding(EMBEDDING_MODEL),
    value: userQuery,
  });

  // 2. 用向量去 Supabase 做相似度搜索（调用 pgvector 的 match_documents RPC）
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 5,
  });

  // 3. 如果向量搜索失败或无结果，回退到全文搜索
  if (error || !data || data.length === 0) {
    const { data: docs } = await supabase
      .from("campus_documents")
      .select("title, content")
      .textSearch("content", userQuery, {
        type: "websearch",
      })
      .limit(5);

    if (!docs || docs.length === 0) return "";

    return docs
      .map((doc) => `标题：${doc.title}\n内容：${doc.content}`)
      .join("\n\n---\n\n");
  }

  return data
    .map(
      (doc: { title: string; content: string }) =>
        `标题：${doc.title}\n内容：${doc.content}`,
    )
    .join("\n\n---\n\n");
}

// ===== API 路由 =====

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages ?? [];

  // 取最后一条用户消息
  const lastUserMessage = messages
    .filter((m: { role: string }) => m.role === "user")
    .at(-1);

  const userQuery = lastUserMessage
    ? extractMessageText(lastUserMessage as Record<string, unknown>)
    : "";

  // 用 embeddingClient 转向量 → Supabase 向量搜索 → 拼接结果
  const context = userQuery
    ? await searchRelevantDocuments(userQuery)
    : "";

  // 拼接系统提示
  const systemPrompt = `你是中国科学技术大学智能校园助手，名字叫"科大精灵"专门回答关于学校的问题。
以下是与此问题相关的学校资料，请基于这些资料回答：

${context || "（未找到相关学校资料，请根据你的知识回答）"}`;

  // 用 chatClient 流式生成回答
  const result = await streamText({
    model: chatClient.chat(CHAT_MODEL),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
  });

  return createTextStreamResponse({
    stream: result.textStream,
  });
}