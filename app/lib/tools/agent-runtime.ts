import "server-only";

import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { getAuthSecrets } from "../auth-store";
import { agentFinalAnswerStep, shouldUseAgentTools } from "../chat-performance";
import type { TelemetryContext } from "../telemetry";
import { getUserAgentDirectories } from "./agent-access";
import { createFsTools } from "./fs-tools";

export type AgentRuntimeContext = {
  requested: boolean;
  activated: boolean;
  authorizedDirectories: string[];
  finalAnswerStep: number;
  tools: ToolSet;
  toolApproval?: Record<string, "approved" | "user-approval">;
  toolApprovalSecret?: string;
};

/** Central policy boundary for intent routing, user grants, tools and approvals. */
export async function createAgentRuntimeContext(input: {
  requested: boolean;
  query: string;
  userId: string;
  signal: AbortSignal;
  telemetry: TelemetryContext;
}): Promise<AgentRuntimeContext> {
  const activated = input.requested && shouldUseAgentTools(input.query);
  const authorizedDirectories = activated
    ? await getUserAgentDirectories(input.userId)
    : [];
  const tools: ToolSet = {};
  if (activated && authorizedDirectories.length > 0) {
    Object.assign(
      tools,
      createFsTools(authorizedDirectories, {
        userId: input.userId,
        signal: input.signal,
        telemetry: input.telemetry,
      }),
    );
  }
  const registered = Object.keys(tools).length > 0;
  if (!registered) {
    return {
      requested: input.requested,
      activated,
      authorizedDirectories,
      finalAnswerStep: activated ? agentFinalAnswerStep(input.query) : 3,
      tools,
    };
  }

  const readApproval =
    process.env.AGENT_REQUIRE_READ_APPROVAL?.trim().toLowerCase() === "false"
      ? "approved"
      : "user-approval";
  const secret =
    process.env.TOOL_APPROVAL_SECRET?.trim() ||
    createHash("sha256")
      .update(`${(await getAuthSecrets()).sessionSecret}:tool-approval`, "utf8")
      .digest("hex");
  return {
    requested: input.requested,
    activated,
    authorizedDirectories,
    finalAnswerStep: agentFinalAnswerStep(input.query),
    tools,
    toolApproval: {
      write_file: "user-approval",
      apply_patch: "user-approval",
      execute_command: "user-approval",
      list_dir: "approved",
      find_files: "approved",
      search_text: readApproval,
      read_file: readApproval,
    },
    toolApprovalSecret: secret,
  };
}
