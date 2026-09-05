import { guardApiRequest } from "../../../lib/api-security";
import { expiredSessionCookie } from "../../../lib/auth-session";

export async function POST(req: Request) {
  const blocked = guardApiRequest(req, { scope: "auth", defaultLimit: 20 });
  if (blocked) return blocked;
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": expiredSessionCookie(req) } },
  );
}
