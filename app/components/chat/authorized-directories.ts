"use client";

/**
 * 授权目录管理 —— 校验函数 + 持久化
 *
 * 目录授权由用户在侧栏确认（DirectoryAuthCard），授权列表持久化到
 * localStorage，随每次聊天请求发送给服务端做路径锚定。
 */

import { loadAuthorizedDirs, saveAuthorizedDirs } from "./conversation-storage";

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
  const dirs = loadAuthorizedDirs().filter((d) => d.toLowerCase() !== dir.toLowerCase());
  saveAuthorizedDirs(dirs);
  return dirs;
}
