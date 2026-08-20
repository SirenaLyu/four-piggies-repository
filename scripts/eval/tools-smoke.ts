// 工具逻辑冒烟测试（绕过 LLM 直接调 execute）
// 用法: npx tsx scripts/eval/tools-smoke.ts
import { setAllowedDirectories, listDirTool, readFileTool, writeFileTool, executeCommandTool } from "../../app/lib/tools/fs-tools";
import * as fs from "node:fs";
import * as path from "node:path";

const WORK = path.join(process.cwd(), ".smoke-test-dir");
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "a.txt"), "hello world");

async function main() {
  // 1. 未授权
  const r1 = await listDirTool.execute({ path: WORK });
  console.log("未授权 list_dir:", r1);

  // 2. 授权后
  setAllowedDirectories([WORK]);
  const r2 = await listDirTool.execute({ path: WORK });
  console.log("授权后 list_dir:\n" + r2);

  // 3. 读文件
  const r3 = await readFileTool.execute({ path: path.join(WORK, "a.txt") });
  console.log("read_file:", r3);

  // 4. 写文件
  const r4 = await writeFileTool.execute({ path: "b.txt", content: "generated", cwd: WORK });
  console.log("write_file:", r4);

  // 5. 执行命令
  const r5 = await executeCommandTool.execute({ command: 'node -e "console.log(1+1)"', cwd: WORK });
  console.log("execute_command:\n" + r5);

  // 6. 路径逃逸拒绝
  const r6 = await readFileTool.execute({ path: "C:\\Windows\\System32\\x.txt" });
  console.log("逃逸 read_file:", r6);

  fs.rmSync(WORK, { recursive: true, force: true });
}
main();
