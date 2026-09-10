"use server";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@ustal/database";
import { clearAdminSessionCookie, setAdminSessionCookie } from "../../lib/session";
import { checkLoginRateLimit, recordFailedLoginAttempt, resetLoginAttempts } from "../../lib/login-rate-limit";

export interface LoginState {
  error: string | null;
}

function clientIp(): string {
  // За Caddy (см. infra/timeweb/app/Caddyfile) — reverse_proxy сам
  // проставляет X-Forwarded-For. "unknown" как общий ключ в худшем случае
  // (заголовок отсутствует, например при прямом обращении в dev) — тогда
  // лимит просто общий на всех, не хуже, чем отсутствие лимита вообще.
  const forwardedFor = headers().get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Введите email и пароль" };
  }

  // Защита от подбора пароля (аудит безопасности, 2026-09-06): админка не
  // проходит через Fastify-рейт-лимитер apps/api и торчит на публичном
  // домене — без этого форму входа можно было перебирать без ограничений.
  const rateLimitKey = clientIp();
  const rateLimit = checkLoginRateLimit(rateLimitKey);
  if (!rateLimit.allowed) {
    const minutes = Math.ceil((rateLimit.retryAfterSeconds ?? 60) / 60);
    return { error: `Слишком много попыток входа. Попробуйте снова через ${minutes} мин.` };
  }

  const db = getDb();
  const admin = await db.query.adminUsers.findFirst({ where: eq(schema.adminUsers.email, email) });

  // Единый ответ на «нет такого email» и «неверный пароль» — не палим,
  // какой из двух неверен (тот же принцип, что и в POST /auth/login).
  const genericError = { error: "Неверный email или пароль" };
  if (!admin) {
    recordFailedLoginAttempt(rateLimitKey);
    return genericError;
  }

  const ok = await argon2.verify(admin.passwordHash, password);
  if (!ok) {
    recordFailedLoginAttempt(rateLimitKey);
    return genericError;
  }

  resetLoginAttempts(rateLimitKey);
  setAdminSessionCookie({ sub: admin.id, email: admin.email, role: admin.role });
  redirect("/");
}

export async function logoutAction() {
  clearAdminSessionCookie();
  redirect("/login");
}
