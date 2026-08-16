import { createOpenAI } from "@ai-sdk/openai";

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
