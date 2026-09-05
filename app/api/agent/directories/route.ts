import { getAuthenticatedUser, unauthorizedResponse } from "../../../lib/auth-session";
import { guardApiRequest } from "../../../lib/api-security";
import { readJsonBody, RequestBodyError } from "../../../lib/request-body";
import { createTelemetryContext, logEvent, withRequestId } from "../../../lib/telemetry";
import {
  AgentAccessError,
  getEligibleAgentRoots,
  getUserAgentDirectories,
  grantUserAgentDirectory,
  revokeUserAgentDirectory,
} from "../../../lib/tools/agent-access";

async function authorize(req: Request) {
  const blocked = guardApiRequest(req, {
    scope: "agentDirectory",
    defaultLimit: 40,
  });
  if (blocked) return { response: blocked, user: null };
  const user = await getAuthenticatedUser(req);
  return user
    ? { response: null, user }
    : { response: unauthorizedResponse(), user: null };
}

async function readPath(req: Request): Promise<string> {
  const body = await readJsonBody<Record<string, unknown>>(req, 8 * 1024);
  const value = typeof body.path === "string" ? body.path.trim() : "";
  if (!value || value.length > 1_024 || /[\0\r\n]/.test(value)) {
    throw new RequestBodyError("目录路径格式不正确", 400);
  }
  return value;
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestBodyError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AgentAccessError) {
    return Response.json({ error: error.message, code: error.code }, { status: 403 });
  }
  return Response.json(
    { error: "Agent 目录操作失败，请稍后重试" },
    { status: 500 },
  );
}

export async function GET(req: Request) {
  const telemetry = createTelemetryContext(req, "agent-directory");
  const { response, user } = await authorize(req);
  if (response || !user) return withRequestId(response!, telemetry.requestId);
  const [directories, eligibleRoots] = await Promise.all([
    getUserAgentDirectories(user.id),
    getEligibleAgentRoots(user.id),
  ]);
  return withRequestId(
    Response.json({ directories, canGrant: eligibleRoots.length > 0 }),
    telemetry.requestId,
  );
}

export async function POST(req: Request) {
  const telemetry = createTelemetryContext(req, "agent-directory");
  const { response, user } = await authorize(req);
  if (response || !user) return withRequestId(response!, telemetry.requestId);
  try {
    const directories = await grantUserAgentDirectory(user.id, await readPath(req));
    logEvent(telemetry, "agent.directory_granted", {
      userId: user.id,
      directoryCount: directories.length,
    });
    return withRequestId(Response.json({ directories }), telemetry.requestId);
  } catch (error) {
    logEvent(telemetry, "agent.directory_grant_denied", {
      userId: user.id,
      reason: error instanceof AgentAccessError ? error.code : "error",
    }, "warn");
    return withRequestId(errorResponse(error), telemetry.requestId);
  }
}

export async function DELETE(req: Request) {
  const telemetry = createTelemetryContext(req, "agent-directory");
  const { response, user } = await authorize(req);
  if (response || !user) return withRequestId(response!, telemetry.requestId);
  try {
    const directories = await revokeUserAgentDirectory(user.id, await readPath(req));
    logEvent(telemetry, "agent.directory_revoked", {
      userId: user.id,
      directoryCount: directories.length,
    });
    return withRequestId(Response.json({ directories }), telemetry.requestId);
  } catch (error) {
    return withRequestId(errorResponse(error), telemetry.requestId);
  }
}
