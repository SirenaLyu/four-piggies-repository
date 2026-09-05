import * as path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { commandExecutionEnabled, evaluateCommand } from "./command-policy";
import {
  applyPatchInWorkspace,
  findFilesInWorkspace,
  listDirectory,
  readFileInWorkspace,
  runCommand,
  searchTextInWorkspace,
  writeFileInWorkspace,
} from "./executor";
import { MAX_WRITE_BYTES, authorizeExistingPath, resolveWritePath } from "./sandbox";
import { logEvent, type TelemetryContext } from "../telemetry";

const NOT_AUTHORIZED =
  "目标路径不在当前账号的服务端授权目录内。请先在侧栏授权目录，等待服务端验证后再重试。";

type ToolContext = {
  userId?: string;
  signal?: AbortSignal;
  telemetry?: TelemetryContext;
};

function failure(error: unknown, code = "tool_failed") {
  return {
    ok: false as const,
    code,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** 每次请求创建独立工具集，以闭包隔离授权、缓存、取消信号和审计上下文。 */
export function createFsTools(allowedDirs: string[], context: ToolContext = {}) {
  const readCache = new Map<string, unknown>();
  const denied = (toolName: string, target: string, error: string, code = "not_authorized") => {
    if (context.telemetry) {
      logEvent(
        context.telemetry,
        "agent.tool_denied",
        { userId: context.userId ?? "unknown", tool: toolName, target, error },
        "warn",
      );
    }
    return failure(error, code);
  };
  const audited = async <T>(
    toolName: string,
    target: string,
    operation: () => Promise<T>,
  ): Promise<T | ReturnType<typeof failure>> => {
    const startedAt = Date.now();
    try {
      const result = await operation();
      const semanticOk = !(
        result &&
        typeof result === "object" &&
        "ok" in result &&
        (result as { ok?: unknown }).ok === false
      );
      const resultRecord = result && typeof result === "object"
        ? result as Record<string, unknown>
        : null;
      let outputBytes = 0;
      try {
        outputBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      } catch {
        outputBytes = 0;
      }
      if (context.telemetry) {
        logEvent(context.telemetry, "agent.tool_completed", {
          userId: context.userId ?? "unknown",
          tool: toolName,
          target,
          durationMs: Date.now() - startedAt,
          ok: semanticOk,
          outputBytes,
          truncated: resultRecord?.truncated === true,
          redactions:
            typeof resultRecord?.redactions === "number"
              ? resultRecord.redactions
              : 0,
          exitCode:
            typeof resultRecord?.code === "number"
              ? resultRecord.code
              : null,
        });
      }
      return result;
    } catch (error) {
      if (context.telemetry) {
        logEvent(
          context.telemetry,
          "agent.tool_failed",
          {
            userId: context.userId ?? "unknown",
            tool: toolName,
            target,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          "warn",
        );
      }
      return failure(error);
    }
  };

  const listDirTool = tool({
    description: "分页列出授权目录下的一层文件和子目录，不递归读取内容。",
    inputSchema: z.object({
      path: z.string().max(1_024).describe("目录绝对路径"),
      offset: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    execute: async ({ path: target, offset, limit }) => {
      const check = await authorizeExistingPath(target, allowedDirs);
      if (!check.ok) return denied("list_dir", target, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      const key = `list:${check.path}:${offset}:${limit}`;
      if (readCache.has(key)) return readCache.get(key);
      const result = await audited("list_dir", check.path, () => listDirectory(check.path, offset, limit));
      readCache.set(key, result);
      return result;
    },
  });

  const findFilesTool = tool({
    description:
      "在授权目录中按文件名通配符递归查找文件。默认忽略 node_modules、.git、.next、构建产物和敏感目录。",
    inputSchema: z.object({
      root: z.string().max(1_024).describe("搜索根目录绝对路径"),
      pattern: z.string().min(1).max(120).describe("文件名通配符，例如 *.ts 或 package*.json"),
      maxResults: z.number().int().min(1).max(200).default(80),
    }),
    execute: async ({ root, pattern, maxResults }) => {
      const check = await authorizeExistingPath(root, allowedDirs);
      if (!check.ok) return denied("find_files", root, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      const key = `find:${check.path}:${pattern}:${maxResults}`;
      if (readCache.has(key)) return readCache.get(key);
      const result = await audited("find_files", check.path, () =>
        findFilesInWorkspace(check.path, pattern, maxResults),
      );
      readCache.set(key, result);
      return result;
    },
  });

  const searchTextTool = tool({
    description:
      "在授权目录的文本文件中搜索固定文本，返回经过敏感信息遮蔽的匹配行。此操作默认需要用户批准。",
    inputSchema: z.object({
      root: z.string().max(1_024).describe("搜索根目录绝对路径"),
      query: z.string().min(1).max(500).describe("要搜索的固定文本，不是正则表达式"),
      filePattern: z.string().max(120).optional().describe("可选文件名通配符，例如 *.tsx"),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(80).default(50),
    }),
    execute: async ({ root, query, filePattern, caseSensitive, maxResults }) => {
      const check = await authorizeExistingPath(root, allowedDirs);
      if (!check.ok) return denied("search_text", root, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      const key = `search:${check.path}:${query}:${filePattern ?? ""}:${caseSensitive}:${maxResults}`;
      if (readCache.has(key)) return readCache.get(key);
      const result = await audited("search_text", check.path, () =>
        searchTextInWorkspace(check.path, query, { filePattern, caseSensitive, maxResults }),
      );
      readCache.set(key, result);
      return result;
    },
  });

  const readFileTool = tool({
    description:
      "按行读取授权目录中的文本文件，返回内容哈希供安全补丁使用；二进制和敏感文件会被拒绝。此操作默认需要用户批准。",
    inputSchema: z.object({
      path: z.string().max(1_024).describe("文件绝对路径"),
      startLine: z.number().int().min(1).max(10_000_000).default(1),
      endLine: z.number().int().min(1).max(10_000_000).optional(),
    }),
    execute: async ({ path: target, startLine, endLine }) => {
      const check = await authorizeExistingPath(target, allowedDirs);
      if (!check.ok) return denied("read_file", target, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      const key = `read:${check.path}:${startLine}:${endLine ?? ""}`;
      if (readCache.has(key)) return readCache.get(key);
      const result = await audited("read_file", check.path, () =>
        readFileInWorkspace(check.path, startLine, endLine),
      );
      readCache.set(key, result);
      return result;
    },
  });

  const writeFileTool = tool({
    description:
      "新建文本文件；覆盖已有文件时必须提供读取所得 SHA-256 哈希。操作需要用户批准并采用临时文件替换。",
    inputSchema: z.object({
      path: z.string().max(1_024).describe("目标文件的绝对或相对路径"),
      content: z.string().max(MAX_WRITE_BYTES).describe("完整文件内容"),
      cwd: z.string().max(1_024).optional().describe("相对路径的基准授权目录"),
      overwrite: z.boolean().default(false),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    }),
    execute: async ({ path: target, content, cwd, overwrite, expectedSha256 }) => {
      const base = cwd ?? allowedDirs[0];
      if (!base) return denied("write_file", target, "没有授权目录，无法写入");
      const check = await resolveWritePath(target, base, allowedDirs);
      if (!check.ok) return denied("write_file", target, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      return audited("write_file", check.path, () =>
        writeFileInWorkspace(check.path, content, { overwrite, expectedSha256 }),
      );
    },
  });

  const applyPatchTool = tool({
    description:
      "基于 read_file 返回的 SHA-256 对文本文件执行精确替换补丁；文件变化时拒绝写入。操作需要用户批准。",
    inputSchema: z.object({
      path: z.string().max(1_024).describe("目标文件绝对路径"),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      replacements: z.array(z.object({
        oldText: z.string().min(1).max(200_000),
        newText: z.string().max(200_000),
        replaceAll: z.boolean().default(false),
      })).min(1).max(20),
    }),
    execute: async ({ path: target, expectedSha256, replacements }) => {
      const check = await authorizeExistingPath(target, allowedDirs);
      if (!check.ok) return denied("apply_patch", target, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      return audited("apply_patch", check.path, () =>
        applyPatchInWorkspace(check.path, expectedSha256, replacements),
      );
    },
  });

  const executeCommandTool = tool({
    description:
      "在授权目录内以无 Shell、最小环境变量方式执行管理员批准的程序和参数组合。每次执行需要用户批准。",
    inputSchema: z.object({
      executable: z.string().min(1).max(260).describe("规则中的可执行程序绝对路径"),
      args: z.array(z.string().max(4_096)).max(100).default([]).describe("参数数组"),
      cwd: z.string().max(1_024).optional().describe("工作目录，默认第一个授权目录"),
    }),
    execute: async ({ executable, args, cwd }) => {
      if (!commandExecutionEnabled()) {
        return denied("execute_command", executable, "命令执行未启用；管理员需设置 AGENT_ENABLE_COMMAND_EXECUTION=true", "disabled");
      }
      const decision = evaluateCommand(executable, args);
      if (!decision.allowed) return denied("execute_command", executable, decision.reason, "command_not_allowed");
      const base = cwd ?? allowedDirs[0];
      if (!base) return denied("execute_command", executable, "没有授权目录，无法执行命令");
      const check = await authorizeExistingPath(base, allowedDirs);
      if (!check.ok) return denied("execute_command", base, `${NOT_AUTHORIZED}（原因：${check.reason}）`);
      return audited("execute_command", check.path, async () => {
        const result = await runCommand(executable, args, check.path, {
          signal: context.signal,
          userId: context.userId,
        });
        return {
          ok: result.code === 0 && !result.timedOut && !result.aborted,
          executable: path.basename(executable),
          ...result,
        };
      });
    },
  });

  return {
    list_dir: listDirTool,
    find_files: findFilesTool,
    search_text: searchTextTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    apply_patch: applyPatchTool,
    execute_command: executeCommandTool,
  };
}

export type FsToolSet = ReturnType<typeof createFsTools>;
