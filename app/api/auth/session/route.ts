import { getAuthenticatedUser } from "../../../lib/auth-session";
import { isRegistrationAllowed } from "../../../lib/auth-store";

export async function GET(req: Request) {
  const [user, registrationAllowed] = await Promise.all([
    getAuthenticatedUser(req),
    isRegistrationAllowed(),
  ]);
  if (!user) {
    return Response.json({ authenticated: false, registrationAllowed }, { status: 401 });
  }
  return Response.json({ authenticated: true, user, registrationAllowed });
}
