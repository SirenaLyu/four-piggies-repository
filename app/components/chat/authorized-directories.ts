"use client";

/**
 * 授权目录管理 —— 校验函数 + localStorage 持久化
 *
 * 目录授权由用户在侧栏确认（DirectoryAuthCard），授权列表持久化到
 * localStorage，随每次聊天请求发送给服务端做路径锚定。
 */

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

/** 判断目录（或其子目录）是否已在授权列表中 */
export function isDirectoryAuthorized(dir: string): boolean {
  const dirs = loadAuthorizedDirs();
  return dirs.some((d) => dir.toLowerCase() === d.toLowerCase());
}

/** 添加授权目录（去重），返回新列表 */
export function addAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs();
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    dirs.push(dir);
    saveAuthorizedDirs(dirs);
  }
  return dirs;
}

/** 移除授权目录，返回新列表 */
export function removeAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs().filter(
    (d) => d.toLowerCase() !== dir.toLowerCase(),
  );
  saveAuthorizedDirs(dirs);
  return dirs;
}
