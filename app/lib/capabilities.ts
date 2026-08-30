export interface AssistantCapabilities {
  knowledgeBase: boolean;
  webSearch: boolean;
  agent: boolean;
}

/** 保留 main 的既有检索行为；Agent 能力采用安全默认关闭。 */
export const DEFAULT_CAPABILITIES: AssistantCapabilities = {
  knowledgeBase: true,
  webSearch: true,
  agent: false,
};

export function normalizeCapabilities(value: unknown): AssistantCapabilities {
  if (!value || typeof value !== "object") return { ...DEFAULT_CAPABILITIES };
  const raw = value as Record<string, unknown>;
  return {
    knowledgeBase:
      typeof raw.knowledgeBase === "boolean"
        ? raw.knowledgeBase
        : DEFAULT_CAPABILITIES.knowledgeBase,
    webSearch:
      typeof raw.webSearch === "boolean"
        ? raw.webSearch
        : DEFAULT_CAPABILITIES.webSearch,
    agent:
      typeof raw.agent === "boolean" ? raw.agent : DEFAULT_CAPABILITIES.agent,
  };
}

export function capabilityFingerprint(capabilities: AssistantCapabilities): string {
  return [capabilities.knowledgeBase, capabilities.webSearch, capabilities.agent]
    .map((enabled) => (enabled ? "1" : "0"))
    .join("");
}
