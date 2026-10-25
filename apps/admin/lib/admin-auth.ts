import jwt from "jsonwebtoken";
import { loadEnv } from "@ustal/config";

/**
 * Отдельная авторизация admin_users (docs/api.md: «не пересекается с
 * users») — свой JWT, свой секрет (ADMIN_SESSION_SECRET, отдельный от
 * JWT_ACCESS_SECRET пользовательского API). Хранится в httpOnly cookie
 * (см. session.ts), а не в Authorization-заголовке — админка это обычное
 * server-rendered приложение, не API-клиент.
 */
export interface AdminSessionPayload {
  sub: string; // admin_users.id
  email: string;
  role: string;
  /** Отпечаток хеша пароля (admin-access.ts passwordFingerprint): смена пароля отзывает сессию. */
  pwv: string;
}

function getSecret(): string {
  const env = loadEnv();
  if (!env.ADMIN_SESSION_SECRET) {
    throw new Error("ADMIN_SESSION_SECRET не задан — админка не может подписывать сессии");
  }
  return env.ADMIN_SESSION_SECRET;
}

export function signAdminSession(payload: AdminSessionPayload): string {
  return jwt.sign(payload, getSecret(), { algorithm: "HS256", expiresIn: "12h" });
}

export function verifyAdminSession(token: string): AdminSessionPayload | null {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as AdminSessionPayload;
  } catch {
    return null;
  }
}
