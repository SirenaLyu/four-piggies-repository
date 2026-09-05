import * as path from "node:path";

export type CommandDecision = { allowed: true } | { allowed: false; reason: string };

type CommandRule = {
  executable: string;
  argsPrefix: string[];
  allowAdditionalArgs?: boolean;
};

export function commandExecutionEnabled(): boolean {
  return process.env.AGENT_ENABLE_COMMAND_EXECUTION?.trim().toLowerCase() === "true";
}

function normalizedExecutable(value: string): string {
  return path.resolve(value).toLowerCase();
}

function legacyAllowedCommands(value = process.env.AGENT_ALLOWED_COMMANDS): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry))
    .map(normalizedExecutable);
}

export function parseCommandRules(value = process.env.AGENT_COMMAND_RULES_JSON): CommandRule[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): CommandRule[] => {
      if (!entry || typeof entry !== "object") return [];
      const raw = entry as Record<string, unknown>;
      if (typeof raw.executable !== "string" || !path.isAbsolute(raw.executable)) return [];
      if (!Array.isArray(raw.argsPrefix) || raw.argsPrefix.some((arg) => typeof arg !== "string")) {
        return [];
      }
      const argsPrefix = raw.argsPrefix as string[];
      if (
        argsPrefix.length > 100 ||
        argsPrefix.some((arg) => arg.length > 4_096 || /[\0\r\n]/.test(arg)) ||
        (argsPrefix.length === 0 && raw.allowAdditionalArgs === true)
      ) {
        return [];
      }
      return [{
        executable: normalizedExecutable(raw.executable),
        argsPrefix,
        allowAdditionalArgs: raw.allowAdditionalArgs === true,
      }];
    });
  } catch {
    return [];
  }
}

function startsWithArgs(args: string[], prefix: string[]): boolean {
  return prefix.every((expected, index) => args[index] === expected);
}

/** Bind command permission to both the executable and an argument prefix. */
export function evaluateCommand(
  executable: string,
  args: string[],
  options: { rulesJson?: string; legacyList?: string } = {},
): CommandDecision {
  if (!path.isAbsolute(executable)) {
    return { allowed: false, reason: "程序必须使用绝对路径" };
  }
  if (args.some((arg) => /[\0\r\n]/.test(arg))) {
    return { allowed: false, reason: "命令参数包含控制字符" };
  }
  const normalized = normalizedExecutable(executable);
  const rules = parseCommandRules(options.rulesJson ?? process.env.AGENT_COMMAND_RULES_JSON);
  const matchingRule = rules.find(
    (rule) =>
      rule.executable === normalized &&
      startsWithArgs(args, rule.argsPrefix) &&
      (rule.allowAdditionalArgs || args.length === rule.argsPrefix.length),
  );
  if (matchingRule) return { allowed: true };

  const legacy = legacyAllowedCommands(options.legacyList ?? process.env.AGENT_ALLOWED_COMMANDS);
  const harmlessLegacyArgs =
    args.length === 0 ||
    (args.length === 1 && ["--version", "-v", "version", "--help"].includes(args[0]));
  if (legacy.includes(normalized) && harmlessLegacyArgs) return { allowed: true };

  return {
    allowed: false,
    reason:
      "命令未匹配 AGENT_COMMAND_RULES_JSON 中的程序与参数规则；旧版程序白名单仅允许无参数或版本查询",
  };
}

/** Backward-compatible helper for configuration diagnostics. */
export function isExecutableAllowed(executable: string): boolean {
  if (!path.isAbsolute(executable)) return false;
  const normalized = normalizedExecutable(executable);
  return (
    parseCommandRules().some((rule) => rule.executable === normalized) ||
    legacyAllowedCommands().includes(normalized)
  );
}
