/**
 * 危险工具执行器 —— write_file 与 execute_command 的实际执行
 *
 * 只在用户批准后由 route 层调用（批准前 SDK 不会执行 execute）。
 * 所有路径经 sandbox 校验；命令执行带超时与输出截断。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import {
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_READ_BYTES,
  resolveInside,
} from "./sandbox";

/** 写文件。相对路径锚定到 cwd，返回实际写入路径。 */
export async function writeFileInWorkspace(
  relativePath: string,
  content: string,
  cwd: string,
): Promise<string> {
  const check = resolveInside(relativePath, cwd);
  if (!check.ok) throw new Error(check.reason);
  await fs.mkdir(path.dirname(check.path), { recursive: true });
  await fs.writeFile(check.path, content, "utf-8");
  return check.path;
}

/** 读文件（绝对路径，截断保护）。路径校验由工具层 authorizePath 完成。 */
export async function readFileInWorkspace(target: string): Promise<string> {
  const buf = await fs.readFile(target);
  const truncated = buf.length > MAX_READ_BYTES;
  const text = buf.subarray(0, MAX_READ_BYTES).toString("utf-8");
  return truncated ? text + `\n\n[文件过大，已截断到前 ${MAX_READ_BYTES} 字节]` : text;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 执行命令。cwd 限定、超时 60s、输出截断 64KB、无交互输入。 */
export function runCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
      if (stdout.length > MAX_OUTPUT_BYTES)
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout 截断]";
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
      if (stderr.length > MAX_OUTPUT_BYTES)
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr 截断]";
    });
    child.on("error", (err) => {
      resolve({
        code: null,
        stdout,
        stderr: stderr + `\n[启动失败] ${err.message}`,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      timedOut = signal === "SIGTERM" || signal === "SIGKILL";
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 列出目录一层（名称 + 类型 + 大小） */
export async function listDirectory(target: string): Promise<string> {
  const entries = await fs.readdir(target, { withFileTypes: true });
  const lines = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(target, e.name);
      if (e.isDirectory()) return `[目录] ${e.name}`;
      if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          return `[文件] ${e.name} (${st.size} B)`;
        } catch {
          return `[文件] ${e.name}`;
        }
      }
      return `[其他] ${e.name}`;
    }),
  );
  return lines.join("\n") || "(空目录)";
}
