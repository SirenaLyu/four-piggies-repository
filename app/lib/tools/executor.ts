import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { COMMAND_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_READ_BYTES } from "./sandbox";

export async function writeFileInWorkspace(target: string, content: string): Promise<string> {
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  await fs.writeFile(/* turbopackIgnore: true */ target, content, "utf-8");
  return target;
}

export async function readFileInWorkspace(target: string): Promise<string> {
  const buf = await fs.readFile(/* turbopackIgnore: true */ target);
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

export function runCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout 截断]";
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr 截断]";
      }
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}\n[启动失败] ${error.message}`, timedOut });
    });
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

export async function listDirectory(target: string): Promise<string> {
  const entries = await fs.readdir(/* turbopackIgnore: true */ target, { withFileTypes: true });
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return `[目录] ${entry.name}`;
      if (entry.isFile()) {
        try {
          const stat = await fs.stat(/* turbopackIgnore: true */ full);
          return `[文件] ${entry.name} (${stat.size} B)`;
        } catch {
          return `[文件] ${entry.name}`;
        }
      }
      return `[其他] ${entry.name}`;
    }),
  );
  return lines.join("\n") || "(空目录)";
}
