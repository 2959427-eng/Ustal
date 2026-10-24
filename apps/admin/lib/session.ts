import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { authorizeAdmin, hasPermission, type AdminPermission, type AdminPrincipal } from "./admin-access";
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

/**
 * Вызывается в начале каждого защищённого Server Component/action. Подпись cookie недостаточна: на каждом запросе
 * сверяемся с admin_users (удалён, отключён, сменил пароль или роль — доступ прекращается сразу, а не через 12 ч).
 */
export async function requireAdminSession(): Promise<AdminPrincipal> {
  const claims = getAdminSession();
  const row = claims?.sub && typeof claims.sub === "string"
    ? await getDb().query.adminUsers.findFirst({ where: eq(schema.adminUsers.id, claims.sub) }).catch(() => undefined)
    : undefined;
  const admin = authorizeAdmin(claims, row);
  if (!admin) redirect("/login");
  return admin;
}

/** Серверная проверка права для привилегированного действия: скрытая кнопка в интерфейсе не защищает action. */
export async function requireAdminPermission(permission: AdminPermission): Promise<AdminPrincipal> {
  const admin = await requireAdminSession();
  if (!hasPermission(admin.role, permission)) throw new Error("Недостаточно прав для этого действия");
  return admin;
}
