"use client";

const DIRS_KEY = "campus-ai-authorized-dirs";

export function loadAuthorizedDirs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DIRS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveAuthorizedDirs(dirs: string[]): boolean {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(DIRS_KEY, JSON.stringify(dirs));
      return true;
    } catch (error) {
      console.warn("[authorized-directories] 无法保存授权目录：", error);
    }
  }
  return false;
}

export function addAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs();
  if (!dirs.some((entry) => entry.toLowerCase() === dir.toLowerCase())) dirs.push(dir);
  saveAuthorizedDirs(dirs);
  return dirs;
}

export function removeAuthorizedDirectory(dir: string): string[] {
  const dirs = loadAuthorizedDirs().filter(
    (entry) => entry.toLowerCase() !== dir.toLowerCase(),
  );
  saveAuthorizedDirs(dirs);
  return dirs;
}
