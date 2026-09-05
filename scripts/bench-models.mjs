// 科大 LLM 代理多模型速度基准测试
// 使用方法：node scripts/bench-models.mjs
// 说明：对 CHAT_MODEL 候选模型分别发起流式请求，度量首 token 延迟(TTFT)与生成速度
import { readFileSync } from "node:fs";

// 手动解析 .env.local（无需 dotenv 依赖）
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="(.*)"\s*$/);
  if (m) env[m[1]] = m[2];
}

const models = [
  "deepseek-v4-flash-ascend", // 当前主模型
  "qwen-chat",                // 当前备用模型
  "qwen3.6-chat",             // 候选
];

// 模拟真实场景：带系统提示词 + 知识库上下文 + 搜索结果的输入
const sysPrompt = `你是中国科学技术大学智能校园助手"科大精灵"，基于以下资料用中文回答问题，适当使用 Markdown 排版。`;
const context = `【知识库检索结果】\n1. 中国科学技术大学学籍管理规定：学生应当在规定年限内完成学业…\n2. 奖学金申请流程：每学年初由学生本人提交申请，学院审核后报送学生工作处…\n（以下省略约2000字知识库片段）\n\n【联网搜索结果】\n通知公告-中国科学技术大学：关于2026年度基金申报的通知…来源：https://www.ustc.edu.cn/tzgg.htm`;

for (const model of models) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `${context}\n\n问题：最近学校有什么最新通知？请简要回答（200字以内）。` },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      console.log(`${model.padEnd(28)} HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let ttft = null;
    let chars = 0;
    let tEnd = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        try {
          const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttft === null) ttft = Date.now() - t0;
            chars += delta.length;
            tEnd = Date.now();
          }
        } catch { /* 忽略不完整分片 */ }
      }
    }
    const total = (tEnd ?? Date.now()) - t0;
    const genMs = total - ttft;
    console.log(
      `${model.padEnd(28)} TTFT=${ttft}ms  生成=${chars}字/${genMs}ms` +
        `（${genMs > 0 ? ((chars / genMs) * 1000).toFixed(0) : "?"}字/s）  总计=${total}ms`,
    );
  } catch (err) {
    console.log(`${model.padEnd(28)} 失败: ${err.message}`);
  }
}
