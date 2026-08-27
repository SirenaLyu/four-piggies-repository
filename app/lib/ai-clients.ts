import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";

// chatClient: 科大 API，用于最终回答问题、生成标题、生成导出文件
export const chatClient = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
  name: "campus-chat",
});

// embeddingClient: 硅基流动 API，用于把用户提问转为向量
export const embeddingClient = createOpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL!,
  apiKey: process.env.EMBEDDING_API_KEY!,
  name: "siliconflow-embed",
});

export const EMBEDDING_MODEL = "BAAI/bge-m3";

// 对话模型：可通过环境变量 CHAT_MODEL 随时切换
// 学校代理可用模型实测：deepseek-v4-flash-ascend / qwen-chat / qwen3.6-chat 等
// （同一模型在不同时段首 token 延迟波动极大，慢时可切换试试）
export const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "deepseek-v4-flash-ascend";

// 备用模型：主模型网络/超时失败时自动降级
export const CHAT_FALLBACK_MODEL =
  process.env.CHAT_FALLBACK_MODEL?.trim() || "qwen-chat";

/** 判断是否为网络/超时类错误（这类错误换一个模型重试才有意义） */
function isNetworkOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = `${error.name} ${error.message}`.toLowerCase();
  return /timeout|connect|eacces|econnreset|econnrefused|enotfound|network|fetch|socket|retry/i.test(
    msg,
  );
}

/**
 * 带降级能力的对话模型：
 * 主模型（deepseek）网络/超时失败时，自动切换到备用模型（qwen）。
 */
export const chatModel = wrapLanguageModel({
  model: chatClient.chat(CHAT_MODEL),
  modelId: CHAT_MODEL,
  middleware: {
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (isNetworkOrTimeoutError(error)) {
          console.warn(
            `[model] 主模型调用失败，降级到 ${CHAT_FALLBACK_MODEL}：${
              (error as Error).message
            }`,
          );
          return await chatClient.chat(CHAT_FALLBACK_MODEL).doStream(params);
        }
        throw error;
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (isNetworkOrTimeoutError(error)) {
          console.warn(
            `[model] 主模型调用失败，降级到 ${CHAT_FALLBACK_MODEL}：${
              (error as Error).message
            }`,
          );
          return await chatClient.chat(CHAT_FALLBACK_MODEL).doGenerate(params);
        }
        throw error;
      }
    },
  },
});
