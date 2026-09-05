import {
  clearUserModelConfig,
  getPublicModelConfig,
  saveUserModelConfig,
} from "../../lib/auth-store";
import { getAuthenticatedUser, unauthorizedResponse } from "../../lib/auth-session";
import { normalizeUserModelBaseUrl } from "../../lib/ai-clients";
import { guardApiRequest } from "../../lib/api-security";
import { readJsonBody, RequestBodyError } from "../../lib/request-body";

function cleanModelName(value: unknown, label: string, required = true): string {
  if (typeof value !== "string") {
    if (!required) return "";
    throw new Error(`请填写${label}`);
  }
  const normalized = value.trim();
  if (!normalized && !required) return "";
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
}

async function authorize(req: Request) {
  const blocked = guardApiRequest(req, { scope: "modelConfig", defaultLimit: 30 });
  if (blocked) return { response: blocked, user: null };
  const user = await getAuthenticatedUser(req);
  return user
    ? { response: null, user }
    : { response: unauthorizedResponse(), user: null };
}

export async function GET(req: Request) {
  const { response, user } = await authorize(req);
  if (response || !user) return response!;
  return Response.json(await getPublicModelConfig(user.id));
}

export async function PUT(req: Request) {
  const { response, user } = await authorize(req);
  if (response || !user) return response!;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 32 * 1024);
  } catch (error) {
    const requestError =
      error instanceof RequestBodyError
        ? error
        : new RequestBodyError("请求格式错误", 400);
    return Response.json({ error: requestError.message }, { status: requestError.status });
  }
  try {
    const baseUrl = normalizeUserModelBaseUrl(cleanModelName(body.baseUrl, "API URL"));
    const model = cleanModelName(body.model, "模型名称");
    const fallbackModel = cleanModelName(body.fallbackModel, "备用模型名称", false);
    const apiKey =
      typeof body.apiKey === "string" && body.apiKey.trim()
        ? body.apiKey.trim().slice(0, 512)
        : undefined;
    return Response.json(
      await saveUserModelConfig(user.id, { baseUrl, model, fallbackModel, apiKey }),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "模型配置保存失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const { response, user } = await authorize(req);
  if (response || !user) return response!;
  await clearUserModelConfig(user.id);
  return Response.json(await getPublicModelConfig(user.id));
}
