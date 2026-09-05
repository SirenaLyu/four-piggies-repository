import { guardApiRequest } from "../../../lib/api-security";
import { AuthStoreError, registerUser } from "../../../lib/auth-store";
import { createSessionToken, sessionCookie } from "../../../lib/auth-session";
import { readJsonBody, RequestBodyError } from "../../../lib/request-body";

export async function POST(req: Request) {
  const blocked = guardApiRequest(req, { scope: "auth", defaultLimit: 10 });
  if (blocked) return blocked;
  let body: { username?: unknown; password?: unknown };
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (error) {
    const requestError =
      error instanceof RequestBodyError
        ? error
        : new RequestBodyError("请求格式错误", 400);
    return Response.json({ error: requestError.message }, { status: requestError.status });
  }
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return Response.json({ error: "请输入用户名和密码" }, { status: 400 });
  }
  try {
    const user = await registerUser(body.username, body.password);
    const token = await createSessionToken(user.id);
    return Response.json(
      { user },
      { status: 201, headers: { "Set-Cookie": sessionCookie(token, req) } },
    );
  } catch (error) {
    if (error instanceof AuthStoreError) {
      const status = error.code === "username_taken" ? 409 : error.code === "registration_disabled" ? 403 : 400;
      return Response.json({ error: error.message }, { status });
    }
    return Response.json({ error: "注册失败，请稍后重试" }, { status: 500 });
  }
}
