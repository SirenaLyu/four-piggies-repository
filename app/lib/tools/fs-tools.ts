import * as path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { commandExecutionEnabled, isExecutableAllowed } from "./command-policy";
import {
  listDirectory,
  readFileInWorkspace,
  runCommand,
  writeFileInWorkspace,
} from "./executor";
import { authorizeExistingPath, resolveWritePath } from "./sandbox";

const NOT_AUTHORIZED =
  "目标路径不在用户授权目录内。请先告诉用户需要授权访问该目录，等待用户确认授权后再重试。";

/** 每次请求创建独立工具集，以闭包隔离本次授权目录。 */
export function createFsTools(allowedDirs: string[]) {
  const listDirTool = tool({
    description: "列出指定目录下的一层文件和子目录。目录必须在用户授权范围内。",
    inputSchema: z.object({ path: z.string().describe("目录绝对路径") }),
    execute: async ({ path: target }) => {
      const check = await authorizeExistingPath(target, allowedDirs);
      if (!check.ok) return `${NOT_AUTHORIZED}（原因：${check.reason}）`;
      try {
        return await listDirectory(check.path);
      } catch (error) {
        return `列出目录失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const readFileTool = tool({
    description: "读取指定文件内容（超过 512KB 自动截断）。文件必须在用户授权范围内。",
    inputSchema: z.object({ path: z.string().describe("文件绝对路径") }),
    execute: async ({ path: target }) => {
      const check = await authorizeExistingPath(target, allowedDirs);
      if (!check.ok) return `${NOT_AUTHORIZED}（原因：${check.reason}）`;
      try {
        return await readFileInWorkspace(check.path);
      } catch (error) {
        return `读取文件失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const writeFileTool = tool({
    description: "写入或新建文件。路径必须在授权范围内；此操作需要用户批准。",
    inputSchema: z.object({
      path: z.string().describe("目标文件的绝对或相对路径"),
      content: z.string().describe("完整文件内容"),
      cwd: z.string().optional().describe("相对路径的基准授权目录"),
    }),
    execute: async ({ path: target, content, cwd }) => {
      const base = cwd ?? allowedDirs[0];
      if (!base) return "没有授权目录，无法写入。请先让用户授权目录。";
      try {
        const check = await resolveWritePath(target, base, allowedDirs);
        if (!check.ok) return `${NOT_AUTHORIZED}（原因：${check.reason}）`;
        return `已写入: ${await writeFileInWorkspace(check.path, content)}`;
      } catch (error) {
        return `写入失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const executeCommandTool = tool({
    description:
      "在授权目录内以无 Shell 模式执行白名单程序。服务端默认关闭，且每次执行需要用户批准。",
    inputSchema: z.object({
      executable: z.string().min(1).max(260).describe("白名单中的可执行程序绝对路径"),
      args: z.array(z.string().max(4096)).max(100).default([]).describe("参数数组"),
      cwd: z.string().optional().describe("工作目录，默认使用第一个授权目录"),
    }),
    execute: async ({ executable, args, cwd }) => {
      if (!commandExecutionEnabled()) {
        return "命令执行功能未启用。管理员需设置 AGENT_ENABLE_COMMAND_EXECUTION=true。";
      }
      if (!isExecutableAllowed(executable)) {
        return `程序不在服务端白名单中: ${path.basename(executable)}`;
      }
      if (args.some((arg) => /[\0\r\n]/.test(arg))) {
        return "命令参数包含不允许的控制字符。";
      }
      const base = cwd ?? allowedDirs[0];
      if (!base) return "没有授权目录，无法执行命令。请先让用户授权目录。";
      const check = await authorizeExistingPath(base, allowedDirs);
      if (!check.ok) return `${NOT_AUTHORIZED}（原因：${check.reason}）`;
      const result = await runCommand(executable, args, check.path);
      const output = [`退出码: ${result.code ?? "N/A"}${result.timedOut ? "（超时）" : ""}`];
      if (result.stdout) output.push(`stdout:\n${result.stdout}`);
      if (result.stderr) output.push(`stderr:\n${result.stderr}`);
      return output.join("\n\n");
    },
  });

  return {
    list_dir: listDirTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    execute_command: executeCommandTool,
  };
}

export type FsToolSet = ReturnType<typeof createFsTools>;
