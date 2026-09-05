import { getUserMemory, changeUserMemory } from "../../lib/auth-store";
import { getAuthenticatedUser, unauthorizedResponse } from "../../lib/auth-session";
import { guardApiRequest } from "../../lib/api-security";
import { readJsonBody, RequestBodyError } from "../../lib/request-body";
import { memoryChangeSchema, MemoryConflictError } from "../../lib/memory";
import { z } from "zod";

export async function GET(req: Request) {
  const blocked = guardApiRequest(req, { scope: "memory", defaultLimit: 60 });
  if (blocked) return blocked;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  return Response.json(await getUserMemory(user.id), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request) {
  const blocked = guardApiRequest(req, { scope: "memory", defaultLimit: 60 });
  if (blocked) return blocked;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  try {
    const input = z.object({ change: memoryChangeSchema, version: z.number().int().nonnegative() }).strict().parse(await readJsonBody(req, 8 * 1024));
    return Response.json(await changeUserMemory(user.id, input.change, input.version));
  } catch (error) {
    const status = error instanceof MemoryConflictError ? 409 : error instanceof RequestBodyError ? error.status : 400;
    return Response.json({ error: error instanceof z.ZodError ? "记忆内容或格式不正确" : error instanceof Error ? error.message : "记忆保存失败" }, { status });
  }
}
