/**
 * 文件工具集 —— 供 streamText 使用的 4 个工具定义
 *
 * 危险级别：
 *   list_dir / read_file        只读，自动执行
 *   write_file / execute_command 危险，需要用户批准
 *
 * 批准机制：streamText 的 toolApproval 配置（见 chat route）。
 * 工具 execute 中先做授权目录校验；未授权返回指引文本让模型引导用户授权。
 */

import { tool } from "ai";
import { z } from "zod";
import {
  listDirectory,
  readFileInWorkspace,
  runCommand,
  writeFileInWorkspace,
} from "./executor";
import { authorizePath } from "./sandbox";

/** 授权目录列表（由 route 层从请求消息中提取后注入模块） */
let allowedDirs: string[] = [];

export function setAllowedDirectories(dirs: string[]) {
  allowedDirs = dirs;
}

export function getAllowedDirectories(): string[] {
  return allowedDirs;
}

/** 未授权时返回的指引文本（引导模型请用户授权） */
const NOT_AUTHORIZED = `目标路径不在用户授权目录内。请先告诉用户需要授权访问该目录，等待用户确认授权后再重试。`;

export const listDirTool = tool({
  description: "列出指定目录下的文件和子目录（一层）。目录必须在用户授权目录内。",
  inputSchema: z.object({ path: z.string().describe("要列出的目录绝对路径") }),
  execute: async ({ path: target }) => {
    const check = authorizePath(target, allowedDirs);
    if (!check.ok) return NOT_AUTHORIZED + `（原因：${check.reason}）`;
    try {
      return await listDirectory(check.path);
    } catch (e) {
      return `列出目录失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const readFileTool = tool({
  description: "读取指定文件内容（超过 512KB 自动截断）。文件必须在用户授权目录内。",
  inputSchema: z.object({ path: z.string().describe("要读取的文件绝对路径") }),
  execute: async ({ path: target }) => {
    const check = authorizePath(target, allowedDirs);
    if (!check.ok) return NOT_AUTHORIZED + `（原因：${check.reason}）`;
    try {
      // check.path 已是授权目录内的绝对路径，直接读取
      return await readFileInWorkspace(check.path);
    } catch (e) {
      return `读取文件失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const writeFileTool = tool({
  description:
    "写入文件（覆盖或新建）。相对路径将锚定到执行工作目录内，绝对路径必须在授权目录内。" +
    "此操作需要用户批准。",
  inputSchema: z.object({
    path: z.string().describe("目标文件路径（绝对或相对）"),
    content: z.string().describe("完整文件内容"),
    cwd: z.string().optional().describe("相对路径的基准目录（省略时使用第一个授权目录）"),
  }),
  execute: async ({ path: target, content, cwd }) => {
    // 该工具配置了用户批准，只有批准后才会执行到这里
    const base = cwd ?? allowedDirs[0];
    if (!base) return "没有授权目录，无法写入。请先让用户授权目录。";
    try {
      const written = await writeFileInWorkspace(target, content, base);
      return `已写入: ${written}`;
    } catch (e) {
      return `写入失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const executeCommandTool = tool({
  description:
    "在用户授权目录内执行命令（如 node script.js / python analyze.py）。" +
    "60 秒超时、输出截断、无交互。此操作需要用户批准。",
  inputSchema: z.object({
    command: z.string().describe('完整命令，如 node analyze.js 或 python -c "..."'),
    cwd: z.string().optional().describe("工作目录（省略时使用第一个授权目录）"),
  }),
  execute: async ({ command, cwd }) => {
    const base = cwd ?? allowedDirs[0];
    if (!base) return "没有授权目录，无法执行命令。请先让用户授权目录。";
    const check = authorizePath(base, allowedDirs);
    if (!check.ok) return NOT_AUTHORIZED + `（原因：${check.reason}）`;
    const result = await runCommand(command, check.path);
    const parts = [
      `退出码: ${result.code ?? "N/A"}${result.timedOut ? "（超时）" : ""}`,
    ];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    return parts.join("\n\n") || "(无输出)";
  },
});

export const FS_TOOLS = {
  list_dir: listDirTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  execute_command: executeCommandTool,
};

export type FsToolName = keyof typeof FS_TOOLS;
