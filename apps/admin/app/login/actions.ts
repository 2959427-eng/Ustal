"use server";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb, schema } from "@ustal/database";
import { clearAdminSessionCookie, setAdminSessionCookie } from "../../lib/session";

export interface LoginState {
  error: string | null;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Введите email и пароль" };
  }

  const db = getDb();
  const admin = await db.query.adminUsers.findFirst({ where: eq(schema.adminUsers.email, email) });

  // Единый ответ на «нет такого email» и «неверный пароль» — не палим,
  // какой из двух неверен (тот же принцип, что и в POST /auth/login).
  const genericError = { error: "Неверный email или пароль" };
  if (!admin) return genericError;

  const ok = await argon2.verify(admin.passwordHash, password);
  if (!ok) return genericError;

  setAdminSessionCookie({ sub: admin.id, email: admin.email, role: admin.role });
  redirect("/");
}

export async function logoutAction() {
  clearAdminSessionCookie();
  redirect("/login");
}
