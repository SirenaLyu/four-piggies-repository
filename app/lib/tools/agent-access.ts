import "server-only";

import {
  findUserById,
  getStoredAgentGrants,
  getUserCount,
  updateStoredAgentGrants,
  type AuthUser,
} from "../auth-store";
import {
  getConfiguredAllowedRoots,
  resolveAuthorizedDirectories,
} from "./sandbox";

type UserRootMap = Record<string, string[]>;

export class AgentAccessError extends Error {
  constructor(
    message: string,
    readonly code: "no_policy" | "outside_policy" | "too_many_grants",
  ) {
    super(message);
    this.name = "AgentAccessError";
  }
}

function sharedRootsEnabled(): boolean {
  return process.env.AGENT_ALLOW_SHARED_ROOTS?.trim().toLowerCase() === "true";
}

function parseUserRootMap(value = process.env.AGENT_USER_ROOTS_JSON): UserRootMap {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, roots]) =>
        Array.isArray(roots)
          ? [[key.toLocaleLowerCase("zh-CN"), roots.filter((root): root is string => typeof root === "string")]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

function configuredRootsForUser(user: AuthUser, map: UserRootMap): string[] | null {
  const byId = map[user.id.toLocaleLowerCase("zh-CN")];
  if (byId) return byId;
  const byName = map[user.username.toLocaleLowerCase("zh-CN")];
  if (byName) return byName;
  return map["*"] ?? null;
}

/**
 * Resolve the administrator-controlled roots for one authenticated user.
 * A single-user local installation keeps the legacy global-root behavior.
 * Multi-user installations fail closed unless an explicit per-user mapping or
 * AGENT_ALLOW_SHARED_ROOTS=true is configured.
 */
export async function getEligibleAgentRoots(userId: string): Promise<string[]> {
  const user = await findUserById(userId);
  if (!user) return [];
  const globalRoots = getConfiguredAllowedRoots();
  if (globalRoots.length === 0) return [];

  const map = parseUserRootMap();
  const configured = configuredRootsForUser(user, map);
  if (configured) {
    return resolveAuthorizedDirectories(configured, globalRoots);
  }
  if ((await getUserCount()) === 1 || sharedRootsEnabled()) {
    return resolveAuthorizedDirectories(globalRoots, globalRoots);
  }
  return [];
}

/** Return only persisted grants that still satisfy the current server policy. */
export async function getUserAgentDirectories(userId: string): Promise<string[]> {
  const [stored, eligible] = await Promise.all([
    getStoredAgentGrants(userId),
    getEligibleAgentRoots(userId),
  ]);
  if (stored.length === 0 || eligible.length === 0) return [];
  return resolveAuthorizedDirectories(stored, eligible);
}

export async function grantUserAgentDirectory(
  userId: string,
  requestedPath: string,
): Promise<string[]> {
  const eligible = await getEligibleAgentRoots(userId);
  if (eligible.length === 0) {
    throw new AgentAccessError(
      "管理员尚未为当前用户配置可授权的 Agent 根目录",
      "no_policy",
    );
  }
  const accepted = await resolveAuthorizedDirectories([requestedPath], eligible);
  if (accepted.length !== 1) {
    throw new AgentAccessError(
      "目录不存在，或不在管理员分配给当前用户的范围内",
      "outside_policy",
    );
  }
  const current = await getUserAgentDirectories(userId);
  if (!current.some((directory) => directory.toLowerCase() === accepted[0].toLowerCase()) && current.length >= 16) {
    throw new AgentAccessError("每个用户最多授权 16 个目录", "too_many_grants");
  }
  const updated = await updateStoredAgentGrants(userId, (stored) => [...stored, accepted[0]]);
  return resolveAuthorizedDirectories(updated, eligible);
}

export async function revokeUserAgentDirectory(
  userId: string,
  requestedPath: string,
): Promise<string[]> {
  const normalized = requestedPath.trim().toLowerCase();
  await updateStoredAgentGrants(userId, (stored) =>
    stored.filter((directory) => directory.toLowerCase() !== normalized),
  );
  return getUserAgentDirectories(userId);
}
