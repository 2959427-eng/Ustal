import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb, getSql, schema } from "./client.js";

/**
 * Отдельно от seed.ts (справочники/онтология) — этот скрипт создаёт ровно
 * одного dev-администратора, если такого email ещё нет (idempotent).
 * Учётные данные — из ENV с безопасными значениями по умолчанию для
 * локальной разработки; ЯВНО не предназначены для боевого использования
 * (см. предупреждение в выводе).
 *   ADMIN_SEED_EMAIL (по умолчанию admin@ustal.local)
 *   ADMIN_SEED_PASSWORD (по умолчанию admin-dev-password-change-me)
 */
async function main() {
  const email = (process.env.ADMIN_SEED_EMAIL ?? "admin@ustal.local").toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD ?? "admin-dev-password-change-me";

  const db = getDb();
  const existing = await db.query.adminUsers.findFirst({ where: eq(schema.adminUsers.email, email) });
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`admin_users: "${email}" уже существует, пропускаем.`);
  } else {
    const passwordHash = await argon2.hash(password);
    await db.insert(schema.adminUsers).values({ email, passwordHash, role: "superadmin" });
    // eslint-disable-next-line no-console
    console.log(`admin_users: создан "${email}".`);
    // eslint-disable-next-line no-console
    console.warn("ВНИМАНИЕ: dev-пароль по умолчанию, смените перед боевым использованием.");
  }

  await getSql().end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Seed admin failed:", err);
  process.exit(1);
});
