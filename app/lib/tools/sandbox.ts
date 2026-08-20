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
