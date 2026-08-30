import * as path from "node:path";

export function commandExecutionEnabled(): boolean {
  return process.env.AGENT_ENABLE_COMMAND_EXECUTION?.trim().toLowerCase() === "true";
}

function allowedCommands(): string[] {
  return (process.env.AGENT_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry).toLowerCase());
}

export function isExecutableAllowed(executable: string): boolean {
  if (!path.isAbsolute(executable)) return false;
  return allowedCommands().includes(path.resolve(executable).toLowerCase());
}
