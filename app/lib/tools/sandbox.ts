import * as fs from "node:fs/promises";
import * as path from "node:path";

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

function isInside(target: string, base: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function isSensitivePath(target: string): boolean {
  const normalized = path.resolve(target).toLowerCase();
  const basename = path.basename(normalized);
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /\.(?:pem|key|pfx|p12)$/i.test(basename) ||
    /^(?:id_rsa|id_ed25519|credentials|\.npmrc|\.pypirc|\.netrc|\.dockercfg)$/i.test(basename) ||
    /^(?:secrets?|credentials?)(?:\.[^.]+)?$/i.test(basename) ||
    /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.gnupg)(?:[\\/]|$)/i.test(normalized) ||
    /(?:^|[\\/])data[\\/]auth(?:[\\/]|$)/i.test(normalized)
  );
}

export function authorizePath(target: string, allowedDirs: string[]): PathCheck {
  if (!allowedDirs || allowedDirs.length === 0) {
    return { ok: false, reason: "没有授权目录" };
  }
  const resolved = path.resolve(target);
  for (const dir of allowedDirs) {
    if (isInside(resolved, dir)) return { ok: true, path: resolved };
  }
  return { ok: false, reason: `路径不在授权目录内: ${resolved}` };
}

export function resolveInside(relativePath: string, cwd: string): PathCheck {
  const resolved = path.resolve(cwd, relativePath);
  return isInside(resolved, cwd)
    ? { ok: true, path: resolved }
    : { ok: false, reason: `路径越界: ${relativePath}` };
}

export function getConfiguredAllowedRoots(): string[] {
  const configured = (process.env.AGENT_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length > 0
    ? configured
    : [];
}

async function realDirectory(target: string): Promise<string | null> {
  try {
    const canonical = await fs.realpath(
      /* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ target),
    );
    const stat = await fs.stat(/* turbopackIgnore: true */ canonical);
    return stat.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export async function resolveAuthorizedDirectories(
  requestedDirs: string[],
  configuredRoots: string[] = getConfiguredAllowedRoots(),
): Promise<string[]> {
  const serverRoots = (
    await Promise.all(configuredRoots.map((root) => realDirectory(root)))
  ).filter((root): root is string => Boolean(root));
  const accepted: string[] = [];
  for (const requested of requestedDirs) {
    if (typeof requested !== "string" || !requested.trim()) continue;
    const lexical = authorizePath(requested, serverRoots);
    if (!lexical.ok) continue;
    const canonical = await realDirectory(lexical.path);
    if (!canonical || !serverRoots.some((root) => isInside(canonical, root))) continue;
    if (!accepted.some((entry) => entry.toLowerCase() === canonical.toLowerCase())) {
      accepted.push(canonical);
    }
  }
  return accepted;
}

export async function authorizeExistingPath(
  target: string,
  allowedDirs: string[],
): Promise<PathCheck> {
  if (isSensitivePath(target)) {
    return { ok: false, reason: "敏感配置、凭据或认证数据不允许通过 Agent 访问" };
  }
  const lexical = authorizePath(target, allowedDirs);
  if (!lexical.ok) return lexical;
  try {
    const canonical = await fs.realpath(/* turbopackIgnore: true */ lexical.path);
    if (!allowedDirs.some((root) => isInside(canonical, root))) {
      return { ok: false, reason: `路径通过符号链接越出授权目录: ${target}` };
    }
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, reason: `路径不存在或无法访问: ${lexical.path}` };
  }
}

export async function resolveWritePath(
  target: string,
  cwd: string,
  allowedDirs: string[],
): Promise<PathCheck> {
  const baseCheck = await authorizeExistingPath(cwd, allowedDirs);
  if (!baseCheck.ok) return baseCheck;
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(baseCheck.path, target);
  if (isSensitivePath(resolved)) {
    return { ok: false, reason: "敏感配置、凭据或认证数据不允许通过 Agent 写入" };
  }
  const lexical = authorizePath(resolved, allowedDirs);
  if (!lexical.ok) return lexical;
  let ancestor = lexical.path;
  while (true) {
    try {
      const canonical = await fs.realpath(/* turbopackIgnore: true */ ancestor);
      if (!allowedDirs.some((root) => isInside(canonical, root))) {
        return { ok: false, reason: `写入路径通过符号链接越出授权目录: ${target}` };
      }
      return { ok: true, path: lexical.path };
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return { ok: false, reason: `无法解析写入路径: ${target}` };
      ancestor = parent;
    }
  }
}

export const MAX_READ_BYTES = 128 * 1024;
export const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_READ_LINES = 400;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_MATCHES = 80;
export const MAX_SEARCH_FILES = 1_000;
export const MAX_SEARCH_BYTES = 12 * 1024 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
