import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";

// chatClient: OpenAI 兼容对话 API，用于最终回答问题、生成标题、生成导出文件
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

// 对话模型：默认使用 DeepSeek API，也可通过 CHAT_MODEL 随时切换。
export const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "deepseek-v4-flash";

// 备用模型：未显式配置时与主模型一致，即不做跨模型降级。
export const CHAT_FALLBACK_MODEL =
  process.env.CHAT_FALLBACK_MODEL?.trim() || CHAT_MODEL;

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
 * 主模型网络/超时失败时，仅在配置了不同备用模型的情况下自动降级。
 */
export const chatModel = wrapLanguageModel({
  model: chatClient.chat(CHAT_MODEL),
  modelId: CHAT_MODEL,
  middleware: {
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (
          CHAT_FALLBACK_MODEL !== CHAT_MODEL &&
          isNetworkOrTimeoutError(error)
        ) {
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
        if (
          CHAT_FALLBACK_MODEL !== CHAT_MODEL &&
          isNetworkOrTimeoutError(error)
        ) {
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
