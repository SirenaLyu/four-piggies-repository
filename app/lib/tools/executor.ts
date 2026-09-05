import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  COMMAND_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_OUTPUT_BYTES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MAX_SEARCH_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_MATCHES,
  MAX_SOURCE_FILE_BYTES,
  MAX_WRITE_BYTES,
  isSensitivePath,
} from "./sandbox.ts";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  "node_modules",
  "coverage",
  "dist",
  "build",
  ".cache",
]);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.08;
}

export function redactSensitiveText(value: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  const replace = (pattern: RegExp, replacer: string | ((...args: string[]) => string)) => {
    value = value.replace(pattern, (...args: string[]) => {
      redactions += 1;
      return typeof replacer === "string" ? replacer : replacer(...args);
    });
  };
  replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g,
    "[REDACTED_TOKEN]",
  );
  replace(
    /\b(api[_-]?key|access[_-]?token|secret|password)\b(\s*[=:]\s*)(["']?)[^\s,"'}]{8,}\3/gi,
    (...args) => `${args[1]}${args[2]}[REDACTED_SECRET]`,
  );
  return { text: value, redactions };
}

async function readRawText(target: string): Promise<{ buffer: Buffer; text: string }> {
  const stat = await fs.stat(/* turbopackIgnore: true */ target);
  if (!stat.isFile()) throw new Error("目标不是普通文件");
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`文件超过可读取上限 ${MAX_SOURCE_FILE_BYTES} 字节`);
  }
  const buffer = await fs.readFile(/* turbopackIgnore: true */ target);
  if (isProbablyBinary(buffer)) throw new Error("检测到二进制文件，Agent 不读取其内容");
  return { buffer, text: buffer.toString("utf8") };
}

export async function readFileInWorkspace(
  target: string,
  startLine = 1,
  endLine?: number,
) {
  const { buffer, text } = await readRawText(target);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const safeStart = Math.max(1, Math.floor(startLine));
  const requestedEnd = endLine == null ? safeStart + MAX_READ_LINES - 1 : Math.floor(endLine);
  const safeEnd = Math.min(lines.length, safeStart + MAX_READ_LINES - 1, Math.max(safeStart, requestedEnd));
  let selected = lines.slice(safeStart - 1, safeEnd).join("\n");
  let byteTruncated = false;
  const selectedBytes = Buffer.byteLength(selected, "utf8");
  if (selectedBytes > MAX_READ_BYTES) {
    selected = Buffer.from(selected, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8");
    byteTruncated = true;
  }
  const safe = redactSensitiveText(selected);
  return {
    ok: true as const,
    path: target,
    sha256: sha256(buffer),
    startLine: safeStart,
    endLine: safeEnd,
    totalLines: lines.length,
    truncated: byteTruncated || safeEnd < lines.length,
    redactions: safe.redactions,
    content: safe.text,
  };
}

export async function writeFileInWorkspace(
  target: string,
  content: string,
  options: { overwrite?: boolean; expectedSha256?: string } = {},
) {
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_WRITE_BYTES) {
    throw new Error(`写入内容超过上限 ${MAX_WRITE_BYTES} 字节`);
  }
  let previous: Buffer | null = null;
  try {
    previous = await fs.readFile(/* turbopackIgnore: true */ target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous && !options.overwrite && !options.expectedSha256) {
    throw new Error("目标文件已存在；请先读取文件，再使用 apply_patch 或提供哈希后覆盖");
  }
  if (options.expectedSha256 && sha256(previous ?? Buffer.alloc(0)) !== options.expectedSha256) {
    throw new Error("文件内容已变化，哈希校验失败；请重新读取后再修改");
  }
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await fs.writeFile(/* turbopackIgnore: true */ temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(/* turbopackIgnore: true */ temporary, target);
  } catch (error) {
    await fs.rm(/* turbopackIgnore: true */ temporary, { force: true });
    throw error;
  }
  return {
    ok: true as const,
    path: target,
    created: previous === null,
    bytes: contentBytes,
    sha256: sha256(content),
  };
}

export type TextReplacement = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

export async function applyPatchInWorkspace(
  target: string,
  expectedSha256: string,
  replacements: TextReplacement[],
) {
  const { buffer, text: original } = await readRawText(target);
  if (sha256(buffer) !== expectedSha256) {
    throw new Error("文件内容已变化，哈希校验失败；请重新读取后再修改");
  }
  let next = original;
  let changed = 0;
  for (const replacement of replacements) {
    if (!replacement.oldText) throw new Error("补丁 oldText 不能为空");
    const occurrences = next.split(replacement.oldText).length - 1;
    if (occurrences === 0) throw new Error("补丁中的 oldText 未在文件中找到");
    if (!replacement.replaceAll && occurrences !== 1) {
      throw new Error("oldText 在文件中出现多次；请提供更精确上下文或显式 replaceAll");
    }
    next = replacement.replaceAll
      ? next.split(replacement.oldText).join(replacement.newText)
      : next.replace(replacement.oldText, replacement.newText);
    changed += replacement.replaceAll ? occurrences : 1;
  }
  const result = await writeFileInWorkspace(target, next, {
    overwrite: true,
    expectedSha256,
  });
  return { ...result, replacements: changed };
}

export async function listDirectory(target: string, offset = 0, limit = 100) {
  const entries = await fs.readdir(/* turbopackIgnore: true */ target, { withFileTypes: true });
  const sorted = entries.sort((left, right) => left.name.localeCompare(right.name));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_LIST_ENTRIES, Math.max(1, Math.floor(limit)));
  const page = sorted.slice(safeOffset, safeOffset + safeLimit);
  const items = await Promise.all(
    page.map(async (entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return { name: entry.name, type: "directory" as const };
      if (entry.isFile()) {
        try {
          const stat = await fs.stat(/* turbopackIgnore: true */ full);
          return { name: entry.name, type: "file" as const, size: stat.size };
        } catch {
          return { name: entry.name, type: "file" as const };
        }
      }
      return { name: entry.name, type: "other" as const };
    }),
  );
  return {
    ok: true as const,
    path: target,
    offset: safeOffset,
    total: sorted.length,
    hasMore: safeOffset + page.length < sorted.length,
    entries: items,
  };
}

function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

async function walkFiles(root: string, visit: (file: string) => Promise<boolean>): Promise<{ scanned: number; stopped: boolean }> {
  const pending = [root];
  let scanned = 0;
  let stopped = false;
  while (pending.length > 0 && scanned < MAX_SEARCH_FILES && !stopped) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (isSensitivePath(full) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) pending.push(full);
      } else if (entry.isFile()) {
        scanned += 1;
        if (!(await visit(full))) {
          stopped = true;
          break;
        }
        if (scanned >= MAX_SEARCH_FILES) break;
      }
    }
  }
  return { scanned, stopped };
}

export async function findFilesInWorkspace(
  root: string,
  pattern: string,
  maxResults = 80,
) {
  const matcher = wildcardPattern(pattern);
  const results: string[] = [];
  const limit = Math.min(200, Math.max(1, maxResults));
  const walk = await walkFiles(root, async (file) => {
    if (matcher.test(path.basename(file))) results.push(path.relative(root, file));
    return results.length < limit;
  });
  return {
    ok: true as const,
    root,
    pattern,
    scannedFiles: walk.scanned,
    truncated: walk.stopped || walk.scanned >= MAX_SEARCH_FILES,
    files: results,
  };
}

export async function searchTextInWorkspace(
  root: string,
  query: string,
  options: { filePattern?: string; caseSensitive?: boolean; maxResults?: number } = {},
) {
  const matcher = options.filePattern ? wildcardPattern(options.filePattern) : null;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const limit = Math.min(MAX_SEARCH_MATCHES, Math.max(1, options.maxResults ?? 50));
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let scannedBytes = 0;
  const walk = await walkFiles(root, async (file) => {
    if (matcher && !matcher.test(path.basename(file))) return true;
    let stat;
    try {
      stat = await fs.stat(/* turbopackIgnore: true */ file);
    } catch {
      return true;
    }
    if (stat.size > MAX_SOURCE_FILE_BYTES || scannedBytes + stat.size > MAX_SEARCH_BYTES) return true;
    let buffer;
    try {
      buffer = await fs.readFile(/* turbopackIgnore: true */ file);
    } catch {
      return true;
    }
    scannedBytes += buffer.length;
    if (isProbablyBinary(buffer)) return true;
    const lines = buffer.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = options.caseSensitive ? lines[index] : lines[index].toLowerCase();
      if (!haystack.includes(needle)) continue;
      const safe = redactSensitiveText(lines[index].slice(0, 500));
      matches.push({ path: path.relative(root, file), line: index + 1, text: safe.text });
      if (matches.length >= limit) return false;
    }
    return true;
  });
  return {
    ok: true as const,
    root,
    query,
    scannedFiles: walk.scanned,
    scannedBytes,
    truncated: walk.stopped || scannedBytes >= MAX_SEARCH_BYTES,
    matches,
  };
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const SAFE_ENV_NAMES = ["NODE_ENV", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "ComSpec"];

export function buildCommandEnvironment(
  source: Record<string, string | undefined> = process.env,
  extraNames = process.env.AGENT_COMMAND_ENV_ALLOWLIST,
): NodeJS.ProcessEnv {
  const requested = (extraNames ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name));
  const names = new Set([...SAFE_ENV_NAMES, ...requested]);
  const selected = Object.fromEntries(
    [...names].flatMap((name) => (source[name] == null ? [] : [[name, source[name]!]])),
  );
  const nodeEnv = ["production", "development", "test"].includes(source.NODE_ENV ?? "")
    ? source.NODE_ENV as "production" | "development" | "test"
    : "production";
  return {
    NODE_ENV: nodeEnv,
    ...selected,
  };
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: buildCommandEnvironment(),
    });
    killer.unref();
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
  }
}

const activeCommandsByUser = new Map<string, number>();

export function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal; userId?: string } = {},
): Promise<CommandResult> {
  const userId = options.userId ?? "anonymous";
  const maxConcurrent = Math.min(
    4,
    Math.max(1, Number(process.env.AGENT_MAX_CONCURRENT_COMMANDS_PER_USER) || 1),
  );
  const active = activeCommandsByUser.get(userId) ?? 0;
  if (active >= maxConcurrent) {
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "当前用户已有命令正在执行，请等待其完成",
      timedOut: false,
      aborted: false,
    });
  }
  activeCommandsByUser.set(userId, active + 1);

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildCommandEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", abort);
      const remaining = Math.max(0, (activeCommandsByUser.get(userId) ?? 1) - 1);
      if (remaining === 0) activeCommandsByUser.delete(userId);
      else activeCommandsByUser.set(userId, remaining);
      const safeOut = redactSensitiveText(result.stdout);
      const safeErr = redactSensitiveText(result.stderr);
      resolve({ ...result, stdout: safeOut.text, stderr: safeErr.text });
    };
    const terminate = () => {
      killProcessTree(child);
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, COMMAND_TIMEOUT_MS);
    const hardStop = setTimeout(() => {
      finish({ code: null, stdout, stderr: `${stderr}\n[进程未能正常退出]`, timedOut, aborted });
    }, COMMAND_TIMEOUT_MS + 5_000);
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        stdout = Buffer.from(stdout, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[stdout 截断]";
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8") + "\n[stderr 截断]";
      }
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}\n[启动失败] ${error.message}`, timedOut, aborted });
    });
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, aborted }));
    if (options.signal?.aborted) abort();
  });
}
