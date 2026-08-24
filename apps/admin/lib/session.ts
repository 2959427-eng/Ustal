import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signAdminSession, verifyAdminSession, type AdminSessionPayload } from "./admin-auth";

const COOKIE_NAME = "ustal_admin_session";

export function setAdminSessionCookie(payload: AdminSessionPayload) {
  const token = signAdminSession(payload);
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export function clearAdminSessionCookie() {
  cookies().delete(COOKIE_NAME);
}

export function getAdminSession(): AdminSessionPayload | null {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyAdminSession(token);
}

/** Вызывается в начале каждого защищённого Server Component/action. */
export function requireAdminSession(): AdminSessionPayload {
  const session = getAdminSession();
  if (!session) redirect("/login");
  return session;
}
