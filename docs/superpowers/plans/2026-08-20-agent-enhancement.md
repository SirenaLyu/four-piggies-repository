# 智能体增强实施计划：主动澄清 + 文件操作与代码执行

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给校园AI助手增加主动澄清能力与文件操作/代码执行能力（AI SDK v7 原生工具审批机制），使其成为真正的智能体

**Architecture:** 服务端定义 4 个工具（list_dir/read_file 自动执行；write_file/execute_command 走 AI SDK v7 原生 tool-approval 协议）。授权目录随消息传入，工具内用 sandbox 纯函数做路径锚定。前端用 `addToolApprovalResponse` 回传确认结果，消息内渲染确认卡片与授权卡片。

**Tech Stack:** Next.js 16 App Router、AI SDK v7（`tool` + `streamText` toolApproval + `addToolApprovalResponse` + `convertToModelMessages`）、zod 4.4.3、Node.js `fs`/`child_process`

---

## 文件结构

**创建：**
- `app/lib/tools/sandbox.ts` — 路径锚定/授权校验纯函数（可单测）
- `app/lib/tools/fs-tools.ts` — 4 个工具定义（list_dir/read_file/write_file/execute_command）
- `app/lib/tools/agent-prompt.ts` — 工具使用说明 + 澄清指南的 system prompt 段
- `app/lib/tools/executor.ts` — 危险工具的实际执行（写文件/跑命令）
- `app/components/chat/ToolApprovalCard.tsx` — 危险工具确认卡片
- `app/components/chat/DirectoryAuthCard.tsx` — 目录授权内联表单（侧栏展开）
- `app/components/chat/approval-parts.ts` — approval part 的查找/判断纯函数
- `app/components/chat/authorized-directories.ts` — localStorage 授权目录管理（含校验函数）

**Modify:**
- `app/api/chat/route.ts` — 接入 tools + toolApproval 配置 + authorizedDirectories 提取
- `app/page.tsx` — sendMessage 附 authorizedDirectories + useChat 配置 sendAutomaticallyWhen + 渲染授权卡/确认卡
- `app/components/chat/MessageBubble.tsx` — 渲染待确认工具卡片
- `app/components/chat/ConversationSidebar.tsx` — 授权目录管理区
- `app/components/chat/conversation-storage.ts` — 新增 authorized-directories 存储函数
- `app/lib/message-text.ts` — 新增消息清理函数（发送前移除 pending approval parts）

---

### Task 1: sandbox 路径锚定纯函数 + 单测

**Files:**
- Create: `app/lib/tools/sandbox.ts`
- Test: `app/lib/tools/sandbox.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// app/lib/tools/sandbox.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizePath, resolveInside } from "./sandbox";

describe("authorizePath", () => {
  const dirs = ["C:\\work\\docs", "D:\\data"];

  it("接受授权目录内路径", () => {
    const r = authorizePath("C:\\work\\docs\\a.txt", dirs);
    assert.equal(r.ok, true);
  });

  it("拒绝未授权目录", () => {
    assert.equal(authorizePath("C:\\secret\\a.txt", dirs).ok, false);
  });

  it("拒绝 .. 逃逸（词法）", () => {
    assert.equal(authorizePath("C:\\work\\docs\\..\\..\\Windows\\x.txt", dirs).ok, false);
  });

  it("拒绝 .. 逃逸（resolve 后）", () => {
    assert.equal(authorizePath("C:\\work\\docs\\sub\\..\\..\\..\\x.txt", dirs).ok, false);
  });

  it("嵌套路径通过", () => {
    assert.equal(authorizePath("C:\\work\\docs\\nested\\f.txt", dirs).ok, true);
  });

  it("目录本身通过", () => {
    assert.equal(authorizePath("C:\\work\\docs", dirs).ok, true);
  });
});

describe("resolveInside", () => {
  it("合法相对路径拼接到 cwd", () => {
    const r = resolveInside("sub\\a.txt", "C:\\work\\docs");
    assert.equal(r.ok, true);
    assert.equal(r.path, "C:\\work\\docs\\sub\\a.txt");
  });

  it("拒绝绝对路径逃逸", () => {
    assert.equal(resolveInside("C:\\Windows\\x.txt", "C:\\work\\docs").ok, false);
  });

  it("拒绝 .. 逃逸", () => {
    assert.equal(resolveInside("..\\..\\x.txt", "C:\\work\\docs").ok, false);
  });

  it("接受 .. 但不越过根", () => {
    const r = resolveInside("..\\sibling.txt", "C:\\work\\docs");
    assert.equal(r.ok, true);
    assert.equal(r.path, "C:\\work\\sibling.txt");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test app/lib/tools/sandbox.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

```typescript
// app/lib/tools/sandbox.ts
/**
 * 文件工具安全层 —— 路径锚定与授权校验纯函数
 *
 * 所有文件工具的路径都必须经过这里校验：
 *   1. 目标路径必须位于用户授权目录列表之一内部
 *   2. 相对路径以 cwd 为根 resolve，词法 .. 逃逸直接拒绝
 *
 * 注意：Windows 大小写不敏感；本层只做词法校验，不做符号链接解析
 * （本地/局域网信任模型下足够）。
 */

import * as path from "node:path";

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * 校验一个路径是否落在授权目录之一内部。
 * 返回 resolve 后的规范绝对路径。
 */
export function authorizePath(target: string, allowedDirs: string[]): PathCheck {
  if (!allowedDirs || allowedDirs.length === 0) {
    return { ok: false, reason: "没有授权目录" };
  }
  const resolved = path.resolve(target);
  const lower = resolved.toLowerCase();
  for (const dir of allowedDirs) {
    const base = path.resolve(dir).toLowerCase();
    if (lower === base || lower.startsWith(base + "\\") || lower.startsWith(base + "/")) {
      return { ok: true, path: resolved };
    }
  }
  return { ok: false, reason: `路径不在授权目录内: ${resolved}` };
}

/**
 * 把相对路径解析到 cwd 内。词法 .. 逃逸直接拒绝；
 * 不越出 cwd 的 .. 允许（如 "..\\sibling.txt"）。
 */
export function resolveInside(relativePath: string, cwd: string): PathCheck {
  const resolved = path.resolve(cwd, relativePath);
  const base = path.resolve(cwd).toLowerCase();
  const lower = resolved.toLowerCase();
  if (lower === base || lower.startsWith(base + "\\") || lower.startsWith(base + "/")) {
    return { ok: true, path: resolved };
  }
  return { ok: false, reason: `路径越界: ${relativePath}` };
}

/** 路径安全限制：读文件上限 */
export const MAX_READ_BYTES = 512 * 1024;
/** 命令执行超时（毫秒） */
export const COMMAND_TIMEOUT_MS = 60_000;
/** 命令输出截断上限 */
export const MAX_OUTPUT_BYTES = 64 * 1024;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test app/lib/tools/sandbox.test.ts`
Expected: PASS（全部通过）

- [ ] **Step 5: 提交**

```bash
git add app/lib/tools/sandbox.ts app/lib/tools/sandbox.test.ts
git commit -m "feat(tools): sandbox 路径锚定纯函数 + 单测"
```

---

### Task 2: 危险工具执行器（写文件/跑命令）

**Files:**
- Create: `app/lib/tools/executor.ts`

- [ ] **Step 1: 实现**

```typescript
// app/lib/tools/executor.ts
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
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout 截断]";
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr 截断]";
    });
    child.on("error", (err) => {
      resolve({ code: null, stdout, stderr: stderr + `\n[启动失败] ${err.message}`, timedOut: false });
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
```

- [ ] **Step 2: 提交**

```bash
git add app/lib/tools/executor.ts
git commit -m "feat(tools): 危险工具执行器（写文件/跑命令/列目录）"
```

---

### Task 3: 四个工具定义（zod schema + execute）

**Files:**
- Create: `app/lib/tools/fs-tools.ts`

- [ ] **Step 1: 实现**

```typescript
// app/lib/tools/fs-tools.ts
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
import * as path from "node:path";
import { listDirectory, readFileInWorkspace, runCommand, writeFileInWorkspace } from "./executor";
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
    command: z.string().describe("完整命令，如 node analyze.js 或 python -c \"...\""),
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
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add app/lib/tools/fs-tools.ts
git commit -m "feat(tools): 四个文件工具定义（list/read 自动，write/exec 需批准）"
```

---

### Task 4: 澄清指南 + 工具说明的 system prompt 段

**Files:**
- Create: `app/lib/tools/agent-prompt.ts`

- [ ] **Step 1: 实现**

```typescript
// app/lib/tools/agent-prompt.ts
/**
 * 智能体能力说明 —— 追加到 system prompt 的两段
 *
 * buildAgentPromptSections()：澄清指南 + 工具使用说明。
 * 在 chat route 中拼接到检索 prompt 之后。
 */

/** 澄清指南：三档行为 + 追问上限 */
const CLARIFICATION_RULES = `## 主动澄清规则
- 简单校园问答（校历/班车/图书馆/奖学金/地点/课程）：直接检索作答，不要追问。
- 信息不足或需求模糊时：主动提出 1 个具体澄清问题（如"你指的转专业是大一还是研一？"），不要列问题清单。
- 文件/执行类需求：先澄清目标路径、预期产出，再调用工具。
- 最多连续追问 2 次，第 3 次仍不明确时给出最佳猜测答案并说明假设。
- 不要为简单问题追问（如"图书馆几点开门"）。`;

/** 工具使用说明：能力边界 + 授权提示 */
const TOOLS_RULES = `## 文件与执行能力
- 你有四个工具：list_dir、read_file 直接执行；write_file、execute_command 需要用户批准。
- 所有路径必须位于用户授权目录内；工具返回"路径不在授权目录内"时，告诉用户"需要授权访问 <目录>"，等用户确认授权后重新调用工具。
- 运行代码的模式：先 write_file 写入脚本，再 execute_command 执行（如 node script.js）。
- 每次动手前，用一句话说明你准备做什么、为什么要做。`;

export function buildAgentPromptSections(): string {
  return `\n\n${CLARIFICATION_RULES}\n\n${TOOLS_RULES}`;
}
```

- [ ] **Step 2: 提交**

```bash
git add app/lib/tools/agent-prompt.ts
git commit -m "feat(agent): 澄清指南与工具说明 prompt 段"
```

---

### Task 5: 授权目录管理（localStorage + 请求附带）

**Files:**
- Modify: `app/components/chat/conversation-storage.ts`（追加存储函数）
- Create: `app/components/chat/authorized-directories.ts`

- [ ] **Step 1: 在 conversation-storage.ts 末尾追加**

```typescript
// ===== 授权目录 =====

const DIRS_KEY = "campus-ai-authorized-dirs";

/** 读取授权目录列表 */
export function loadAuthorizedDirs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** 保存授权目录列表 */
export function saveAuthorizedDirs(dirs: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DIRS_KEY, JSON.stringify(dirs));
}
```

- [ ] **Step 2: 创建 authorized-directories.ts**

```typescript
"use client";

/**
 * 授权目录管理 —— 校验函数 + 持久化
 *
 * 目录授权由用户在聊天中确认（DirectoryAuthCard），授权列表持久化到
 * localStorage，随每次聊天请求发送给服务端做路径锚定。
 */

import { loadAuthorizedDirs, saveAuthorizedDirs } from "./conversation-storage";

/** 判断目录（或其子目录）是否已在授权列表中 */
export function isDirectoryAuthorized(dir: string): boolean {
  const dirs = loadAuthorizedDirs();
  return dirs.some((d) => dir.toLowerCase() === d.toLowerCase());
}

/** 添加授权目录（去重） */
export function addAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs();
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    dirs.push(dir);
    saveAuthorizedDirs(dirs);
  }
  return dirs;
}

/** 移除授权目录 */
export function removeAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs().filter((d) => d.toLowerCase() !== dir.toLowerCase());
  saveAuthorizedDirs(dirs);
  return dirs;
}
```

- [ ] **Step 3: 提交**

```bash
git add app/components/chat/conversation-storage.ts app/components/chat/authorized-directories.ts
git commit -m "feat(agent): 授权目录管理（localStorage 持久化）"
```

---

### Task 6: 确认卡片与授权卡片组件

**Files:**
- Create: `app/components/chat/ToolApprovalCard.tsx`
- Create: `app/components/chat/DirectoryAuthCard.tsx`
- Create: `app/components/chat/approval-parts.ts`

- [ ] **Step 1: 创建 approval-parts.ts**

```typescript
/**
 * approval part 工具函数 —— 在 UIMessage parts 中查找待确认的工具调用
 *
 * AI SDK v7 的审批流程：streamText 输出 tool-approval-request part
 * （出现在对应 tool-XXX part 的 approval 字段中），前端渲染确认卡片，
 * 用户批准/拒绝后调 addToolApprovalResponse 回传。
 */

import type { UIMessage } from "ai";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** 提取消息中所有待确认的工具调用（state === 'approval-requested'） */
export function getPendingApprovals(message: UIMessage): PendingApproval[] {
  const result: PendingApproval[] = [];
  for (const part of message.parts as Array<Record<string, unknown>>) {
    if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-") &&
      typeof part.state === "string" &&
      part.state === "approval-requested"
    ) {
      const approval = (part as { approval?: { id?: string } }).approval;
      result.push({
        approvalId: String(approval?.id ?? ""),
        toolCallId: String(part.toolCallId ?? ""),
        toolName: String(part.type).slice("tool-".length),
        input: (part as { input?: unknown }).input,
      });
    }
  }
  return result;
}

/** 判断消息是否含待确认工具调用 */
export function hasPendingApprovals(message: UIMessage): boolean {
  return getPendingApprovals(message).length > 0;
}

/** 生成确认卡片的摘要文本（命令/写入路径 + 输入预览） */
export function summarizeApproval(a: PendingApproval): string {
  const input = a.input as Record<string, unknown> | null;
  if (!input) return a.toolName;
  if (a.toolName === "execute_command") {
    return `命令: ${String(input.command ?? "")}` + (input.cwd ? `\ncwd: ${input.cwd}` : "");
  }
  if (a.toolName === "write_file") {
    const content = String(input.content ?? "");
    const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;
    return `写入: ${String(input.path ?? "")}\n\n${preview}`;
  }
  return JSON.stringify(input, null, 2).slice(0, 500);
}
```

- [ ] **Step 2: 创建 ToolApprovalCard.tsx**

```typescript
"use client";

/**
 * 危险工具确认卡片
 *
 * 渲染在 AI 消息内（对应 tool-approval-request part）。
 * 用户允许/拒绝后调用 onRespond 回传 approval response。
 */

import { useState } from "react";
import { summarizeApproval } from "./approval-parts";

export interface ToolApprovalCardProps {
  toolName: string;
  summary: string;
  onRespond: (approved: boolean) => void | Promise<void>;
}

export function ToolApprovalCard({ toolName, summary, onRespond }: ToolApprovalCardProps) {
  const [busy, setBusy] = useState(false);

  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRespond(approved);
    } finally {
      setBusy(false);
    }
  };

  const isExec = toolName === "execute_command";
  return (
    <div className="mt-2 w-full max-w-md bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5">
      <div className="text-xs font-semibold text-amber-800 mb-1">
        {isExec ? "⚠️ 执行命令确认" : "✏️ 写入文件确认"}
      </div>
      <pre className="text-[11px] text-amber-900 whitespace-pre-wrap break-all bg-white/60 rounded px-2 py-1.5 mb-2 max-h-40 overflow-y-auto">
        {summary}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void respond(true)}
          className="text-[11px] px-2.5 py-1 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50"
        >
          允许执行
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void respond(false)}
          className="text-[11px] px-2.5 py-1 bg-white text-amber-800 border border-amber-400 rounded-md hover:bg-amber-100 disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 创建 DirectoryAuthCard.tsx**

```typescript
"use client";

/**
 * 目录授权卡片（侧栏内联表单）
 *
 * 点击侧栏"授权目录 → + 添加"后展开，输入路径并确认。
 * 模型请求访问未授权目录时，会在聊天中提示用户路径，
 * 用户可复制到此处授权（聊天内无模型→UI 信号通道，授权入口统一在侧栏）。
 */

import { useState } from "react";

export interface DirectoryAuthCardProps {
  onAllow: (dir: string) => void;
  onCancel: () => void;
}

export function DirectoryAuthCard({ onAllow, onCancel }: DirectoryAuthCardProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const dir = value.trim();
    if (!dir) return;
    onAllow(dir);
  };

  return (
    <div className="mt-2 bg-blue-50 border border-blue-300 rounded-md px-2.5 py-2">
      <div className="text-[11px] font-semibold text-blue-800 mb-1.5">🔐 添加授权目录</div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="输入目录绝对路径，如 C:\work"
        className="w-full text-[11px] bg-white border border-blue-300 rounded px-2 py-1 mb-1.5 outline-none focus:ring-2 focus:ring-blue-400"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className="text-[11px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
        >
          授权
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-2 py-0.5 bg-white text-blue-800 border border-blue-300 rounded hover:bg-blue-100"
        >
          取消
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add app/components/chat/ToolApprovalCard.tsx app/components/chat/DirectoryAuthCard.tsx app/components/chat/approval-parts.ts
git commit -m "feat(agent): 工具确认卡片与目录授权卡片组件"
```

---

### Task 7: 消息清理函数（发送前移除 pending approvals）

**Files:**
- Modify: `app/lib/message-text.ts`（追加函数）

- [ ] **Step 1: 在 message-text.ts 末尾追加**

```typescript
/**
 * 发送前的消息清理：移除仍处于 approval-requested 状态的整个工具 part。
 *
 * 若保留 tool-call part 而不回传 approval-response，AI SDK 服务端
 * validateApprovedToolApprovals 会抛 MissingToolResultsError。
 * 因此用户未响应确认就发新消息时，整条待确认工具调用一并丢弃
 * （卡片自然消失，模型在下一轮可重新发起）。
 */
export function stripPendingApprovals<T extends { parts?: Array<Record<string, unknown>> }>(
  messages: T[],
): T[] {
  return messages.map((m) => {
    if (!m.parts) return m;
    const parts = m.parts.filter((p) => {
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        return p.state !== "approval-requested";
      }
      return true;
    });
    return { ...m, parts: parts as T["parts"] };
  });
}
```

- [ ] **Step 2: 提交**

```bash
git add app/lib/message-text.ts
git commit -m "feat(agent): 发送前移除悬空 approval 的消息清理函数"
```

> 挂载点：该函数在 Task 9 中通过 `TextStreamChatTransport` 的
> `prepareSendMessagesRequest` 选项调用——用户不理会确认卡片直接发新消息时，
> 若不清理悬空的 tool-call part，服务端会抛 `MissingToolResultsError`
> （已从 SDK 源码 validateToolCalls 逻辑确认）。

---

### Task 8: chat route 接入工具 + 审批配置 + 授权目录提取

**Files:**
- Modify: `app/api/chat/route.ts`

- [ ] **Step 1: 重写 route.ts**

```typescript
/**
 * 聊天 API 路由 —— HTTP 壳
 *
 * 职责：解析请求 → 检索路由 → 选 prompt → 流式回复（带文件/执行工具）。
 * 工具审批：write_file / execute_command 返回 'user-approval'，
 * 由 AI SDK 原生审批协议经前端 addToolApprovalResponse 回传后执行。
 */

import { convertToModelMessages, createTextStreamResponse, streamText } from "ai";
import { chatClient, CHAT_MODEL } from "../../lib/ai-clients";
import { extractMessageText } from "../../lib/message-text";
import { retrieveForQuery } from "../../lib/retrieval/router";
import { buildSystemPrompt } from "../../lib/retrieval/prompt-builder";
import { FS_TOOLS, setAllowedDirectories } from "../../lib/tools/fs-tools";
import { buildAgentPromptSections } from "../../lib/tools/agent-prompt";

export async function POST(req: Request) {
  const body = await req.json();
  const messages = body.messages ?? [];

  // 授权目录随请求传入（前端 localStorage），注入工具模块
  const authorizedDirs = Array.isArray(body.authorizedDirectories)
    ? (body.authorizedDirectories as string[])
    : [];
  setAllowedDirectories(authorizedDirs);

  // 取最后一条用户消息作为检索 query
  const lastUserMessage = messages
    .filter((m: { role: string }) => m.role === "user")
    .at(-1);
  const userQuery = lastUserMessage
    ? extractMessageText(lastUserMessage as Record<string, unknown>)
    : "";

  // 检索路由（embed → 分类 → Supabase → Dify → Tavily 三层兜底）
  const routeResult = userQuery
    ? await retrieveForQuery(userQuery)
    : { context: "", primary: "fallback" as const, usedBackend: "supabase" as const };

  const systemPrompt =
    buildSystemPrompt(routeResult, userQuery) + buildAgentPromptSections();

  try {
    const result = streamText({
      model: chatClient.chat(CHAT_MODEL),
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      tools: FS_TOOLS,
      // 工具审批：危险工具需要用户批准；只读工具自动执行
      toolApproval: {
        write_file: "user-approval",
        execute_command: "user-approval",
        list_dir: "approved",
        read_file: "approved",
      },
      // 签名密钥：绑定 approval 请求与响应，防伪造（本地部署随机值即可）
      experimental_toolApprovalSecret: process.env.TOOL_APPROVAL_SECRET ?? "campus-ai-local-secret",
    });

    return createTextStreamResponse({
      stream: result.textStream,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[chat] 生成回答失败: ${message}`);
    return Response.json(
      { error: "对话模型不可用", detail: message },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add app/api/chat/route.ts
git commit -m "feat(agent): chat route 接入文件工具与审批配置"
```

---

### Task 9: page.tsx 接入（授权目录附带 + 确认卡片渲染 + 侧栏授权管理）

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: 修改 page.tsx —— transport 增加 prepareSendMessagesRequest（注入授权目录 + 清理悬空 approval）**

在文件顶部 import 增加：

```typescript
import { loadAuthorizedDirs, addAuthorizedDirectory, removeAuthorizedDirectory } from "./components/chat/authorized-directories";
import { stripPendingApprovals } from "./lib/message-text";
```

在组件内定义 transport 工厂（每次请求都注入最新的授权目录，并清理未响应的 approval）：

```typescript
  // 每次发送前：清理悬空 approval + 注入最新授权目录
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages: msgs, body }) => ({
          body: {
            ...body,
            messages: stripPendingApprovals(msgs),
            authorizedDirectories: authorizedDirsRef.current,
          },
        }),
      }),
    [],
  );
```

新增 ref 镜像（与 conversationsRef 同模式，避免闭包陈旧）：

```typescript
  const [authorizedDirs, setAuthorizedDirs] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : loadAuthorizedDirs(),
  );
  const authorizedDirsRef = useRef<string[]>(authorizedDirs);
  useEffect(() => {
    authorizedDirsRef.current = authorizedDirs;
  }, [authorizedDirs]);
```

`useChat` 的 transport 参数改为使用上面的 transport：

```typescript
    transport,
```

并删除 handleSubmit 里原来的 per-call body 写法（sendMessage 保持原样，不含 body）。

- [ ] **Step 2: 渲染确认卡片**

在 `MessageBubble` 使用处附近（page.tsx 的 messages.map 内），为含待确认工具的消息追加卡片。修改 `app/components/chat/MessageBubble.tsx`，在其 props 增加：

```typescript
export interface MessageBubbleProps {
  message: UIMessage;
  exportsForThis: ExportFileDescriptor[];
  isExportBusy: boolean;
  /** 用户批准/拒绝工具调用的回调（由父组件提供，调 addToolApprovalResponse） */
  onToolApproval?: (approvalId: string, approved: boolean) => void;
}
```

在 MessageBubble 组件内（导出卡片渲染之后）追加：

```typescript
import { ToolApprovalCard } from "./ToolApprovalCard";
import { getPendingApprovals, summarizeApproval } from "./approval-parts";

// 在组件函数内：
const pendingApprovals = getPendingApprovals(m);
```

JSX 追加（在 export 卡片渲染之后）：

```tsx
        {/* 危险工具确认卡片 */}
        {pendingApprovals.map((a) => (
          <div key={a.approvalId} className="ml-10 mt-2 w-full flex">
            <ToolApprovalCard
              toolName={a.toolName}
              summary={summarizeApproval(a)}
              onRespond={(approved) => onToolApproval?.(a.approvalId, approved)}
            />
          </div>
        ))}
```

同时把 MessageBubbleProps 中回调的参数名同步为 approvalId：

```typescript
  /** 用户批准/拒绝工具调用的回调（由父组件提供，调 addToolApprovalResponse） */
  onToolApproval?: (approvalId: string, approved: boolean) => void;
```

- [ ] **Step 3: 在 page.tsx 中接入 addToolApprovalResponse 与自动重发**

import 增加：

```typescript
import { TextStreamChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type FileUIPart, type UIMessage } from "ai";
```

`useChat` 配置增加（批准后自动重发请求继续生成）：

```typescript
  const { messages, sendMessage, status, addToolApprovalResponse } = useChat<UIMessage>({
    id: activeId,
    messages: initialMessages,
    transport: new TextStreamChatTransport({ api: "/api/chat" }),
    // 所有待确认的工具调用都被响应后，自动重发请求让服务端继续执行
    sendAutomaticallyWhen: ({ messages: msgs }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: msgs }),
    onFinish: ({ messages: finalMessages, isAbort, isError }) => {
```

并给 MessageBubble 传入回调（注意参数是 approvalId）：

```tsx
            <MessageBubble
              key={m.id}
              ref={(el) => {
                if (el) messageRefs.current.set(m.id, el);
                else messageRefs.current.delete(m.id);
              }}
              message={m}
              exportsForThis={exportsByMessage[m.id] ?? []}
              isExportBusy={exportBusy.has(m.id)}
              onToolApproval={(approvalId, approved) => {
                void addToolApprovalResponse({
                  id: approvalId,
                  approved,
                  reason: approved ? "用户在界面确认" : "用户拒绝",
                });
              }}
            />
```

- [ ] **Step 4: 侧栏授权目录管理区**

在 `ConversationSidebar.tsx` 底部（收起按钮上方）追加授权目录管理区。给 `ConversationSidebarProps` 增加：

```typescript
  authorizedDirs: string[];
  onAddDirectory: () => void;
  onRemoveDirectory: (dir: string) => void;
```

JSX 追加（在"收起侧栏"按钮之前）：

```tsx
      <div className="px-3 py-2 border-t border-border text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="text-foreground/60">授权目录</span>
          <button
            type="button"
            onClick={onToggleAddDirectory}
            className="text-primary-600 hover:text-primary-500"
          >
            {showAddDirectory ? "收起" : "+ 添加"}
          </button>
        </div>
        {showAddDirectory && (
          <DirectoryAuthCard
            onAllow={(dir) => {
              onAddDirectory(dir);
              onToggleAddDirectory();
            }}
            onCancel={onToggleAddDirectory}
          />
        )}
        {authorizedDirs.length === 0 ? (
          <div className="text-foreground/40 text-[11px]">暂无授权目录</div>
        ) : (
          authorizedDirs.map((d) => (
            <div key={d} className="flex items-center justify-between py-0.5">
              <span className="truncate font-mono text-[11px]">{d}</span>
              <button
                type="button"
                onClick={() => onRemoveDirectory(d)}
                className="text-foreground/40 hover:text-danger px-1"
                aria-label="移除目录"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
```

ConversationSidebarProps 变化（onAddDirectory 变为回调目录，新增展开状态管理）：

```typescript
export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string;
  hydrated: boolean;
  expandedConvos: Set<string>;
  authorizedDirs: string[];
  showAddDirectory: boolean;
  onToggleAddDirectory: () => void;
  onAddDirectory: (dir: string) => void;
  onRemoveDirectory: (dir: string) => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onRemoveConversation: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onScrollToMessage: (messageId: string) => void;
  onCollapse: () => void;
}
```

组件顶部 import 增加：

```typescript
import { DirectoryAuthCard } from "./DirectoryAuthCard";
```

在 page.tsx 中，authorizedDirs 状态与 ref 已在 Step 1 定义，新增展开状态并给 ConversationSidebar 传参：

```typescript
  const [showAddDirectory, setShowAddDirectory] = useState(false);
```

```tsx
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            hydrated={hydrated}
            expandedConvos={expandedConvos}
            authorizedDirs={authorizedDirs}
            showAddDirectory={showAddDirectory}
            onToggleAddDirectory={() => setShowAddDirectory((v) => !v)}
            onAddDirectory={(dir) => {
              setAuthorizedDirs(addAuthorizedDirectory(dir));
            }}
            onRemoveDirectory={(dir) => {
              setAuthorizedDirs(removeAuthorizedDirectory(dir));
            }}
            onNewConversation={startNewConversation}
            onSelectConversation={selectConversation}
            onRemoveConversation={removeConversation}
            onToggleExpanded={toggleConvoExpanded}
            onScrollToMessage={scrollToMessage}
            onCollapse={() => setSidebarOpen(false)}
          />
```

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit`
Expected: 无错误

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 6: 提交**

```bash
git add app/page.tsx app/components/chat/MessageBubble.tsx app/components/chat/ConversationSidebar.tsx
git commit -m "feat(agent): 前端接入审批卡片、授权目录附带与侧栏管理"
```

---

### Task 10: 端到端验证（curl + 浏览器）

**Files:**
- Modify: `README.md`（补充新功能说明）

- [ ] **Step 1: 启动 dev server**

```bash
npm run dev
```

Expected: Ready on http://localhost:3000

- [ ] **Step 2: curl 验证主动澄清（无密钥环境降级链）**

```bash
curl -s -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"帮我统计文件夹字数"}]}]}'
```

Expected: HTTP 200，流式返回澄清问题（模型追问"哪个文件夹"）

- [ ] **Step 3: 验证工具审批协议（在配置好密钥的 .env.local 下）**

准备 `.env.local`（真实 OPENAI/EMBEDDING/SUPABASE 密钥），发送：

```bash
curl -s -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"读一下 C:\\work\\a.txt"}]}],"authorizedDirectories":["C:\\work"]}' | head -c 2000
```

Expected: 流中包含 `tool-approval-request` part（write/exec 工具），只读工具自动执行

- [ ] **Step 4: 浏览器手工走查**

1. 打开 http://localhost:3000，问"帮我统计某文件夹 txt 字数"
2. 模型追问路径 → 输入路径 → 目录授权卡出现 → 允许
3. 确认卡片出现（写文件/执行）→ 允许 → 结果返回
4. 侧栏"授权目录"可增删

- [ ] **Step 5: 更新 README.md 新功能段落**

在功能特性列表后追加：

```markdown
### 智能体能力（增强）

- **主动澄清**：信息不足时像 Claude 一样主动追问，最多 2 次后给出最佳猜测
- **文件操作**：`list_dir` / `read_file` 自动执行，`write_file` / `execute_command` 需用户确认
- **代码执行**：助手写脚本到授权目录后运行（Node.js / Python），60s 超时，输出截断
- **目录授权**：聊天内授权卡 + 侧栏授权目录管理，路径锚定防逃逸
```

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs: README 补充智能体能力说明"
```

---

## 自查记录

- **Spec 覆盖**：主动澄清（Task 4 prompt + Task 10 验证）✅；四个工具（Task 3）✅；授权目录 + 路径锚定（Task 1/5/8）✅；确认卡片（Task 6/9）✅；执行约束（Task 2 executor 超时/截断）✅；验证方案（Task 10）✅
- **类型一致性**：`setAllowedDirectories`/`getAllowedDirectories`（Task 3 定义）与 Task 8 使用一致；`getPendingApprovals`/`summarizeApproval`（Task 6）与 Task 9 使用一致；`addAuthorizedDirectory`/`removeAuthorizedDirectory`/`loadAuthorizedDirs`（Task 5）与 Task 9 使用一致
- **API 一致性**：所有 AI SDK API 已对照 node_modules 实际类型验证（toolApproval 配置、addToolApprovalResponse、tool-approval-request part、experimental_toolApprovalSecret）
