// 临时诊断脚本：直连 /api/chat 度量流式各阶段客户端耗时
const API = process.argv[2] || "http://localhost:3001/api/chat";
const question = process.argv[3] || "如何申请奖学金？";

const t0 = Date.now();
const res = await fetch(API, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: question }] },
    ],
  }),
});
console.log(`[client] 响应头到达: ${Date.now() - t0}ms, status=${res.status}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let first = false;
let chunks = 0;
let chars = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (!first) {
    first = true;
    console.log(`[client] 首块内容到达(TTFC): ${Date.now() - t0}ms`);
  }
  chunks++;
  chars += decoder.decode(value, { stream: true }).length;
}
console.log(`[client] 流结束: ${Date.now() - t0}ms, 共 ${chunks} 块 / ${chars} 字符`);
