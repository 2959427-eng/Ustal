// E2E безопасности админки (аудит 2026-10-23, H3): отзыв сессий через БД, роли на сервере, обход через аргументы
// server action. Только для локальной/тестовой БД: создаёт и удаляет свои строки (admin_users, users).
// Запуск: собранная админка на http://localhost:4100 (next start), DATABASE_URL на ту же тестовую БД,
// дев-админ засеян (npm run db:seed-admin). CHROMIUM_PATH — путь к chrome.
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(new URL("../packages/database/package.json", import.meta.url));
const postgres = require("postgres");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against a non-local DATABASE_URL");
const BASE = "http://localhost:4100";
const OWNER = { email: process.env.ADMIN_SEED_EMAIL ?? "admin@ustal.local", password: process.env.ADMIN_SEED_PASSWORD ?? "admin-dev-password-change-me" };
const MOD = { email: "e2e-moderator@ustal.test", password: "e2e-moderator-password-123" };
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
let failures = 0;
const check = (label, cond, extra) => { console.log(`${cond ? "OK  " : "FAIL"} ${label}${!cond && extra ? " — " + extra : ""}`); if (!cond) failures++; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--headless=new"] });
const login = async (who) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 8000 }).catch(() => {});
  return { ctx, page };
};
const at = async (page, path) => { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" }); return new URL(page.url()).pathname; };

const [city] = await sql`INSERT INTO cities (name, region_name, federal_district, timezone) VALUES ('E2E-город', 'E2E', 'E2E', 'Asia/Vladivostok') RETURNING id`;
const [target] = await sql`INSERT INTO users (phone, password_hash, status) VALUES ('+70000000991', 'x', 'active') RETURNING id`;
await sql`INSERT INTO user_profiles (user_id, name, city_id, accepted_rules_at, accepted_pdn_at) VALUES (${target.id}, 'E2E цель', ${city.id}, now(), now())`;
const [deleted] = await sql`INSERT INTO users (phone, password_hash, status) VALUES ('+70000000992', 'x', 'deleted') RETURNING id`;
await sql`INSERT INTO user_profiles (user_id, name, city_id, accepted_rules_at, accepted_pdn_at) VALUES (${deleted.id}, 'E2E удалённый', ${city.id}, now(), now())`;
await sql`DELETE FROM admin_users WHERE email = ${MOD.email}`;
const [mod] = await sql`INSERT INTO admin_users (email, password_hash, role) VALUES (${MOD.email}, ${await argon2.hash(MOD.password)}, 'moderator') RETURNING id`;
const status = async (id) => (await sql`SELECT status FROM users WHERE id = ${id}`)[0].status;
const clickIn = async (page, rowText, buttonText) => {
  const row = await page.$(`tr:has(td:has-text("${rowText}"))`);
  if (!row) return false;
  await row.$eval(`button:has-text("${buttonText}")`, (el) => el.click());
  await page.waitForTimeout(1200);
  return true;
};

try {
  // 1. Владелец входит и работает как раньше.
  const owner = await login(OWNER);
  check("владелец входит", new URL(owner.page.url()).pathname === "/");
  check("владелец открывает /users", (await at(owner.page, "/users")) === "/users");
  await clickIn(owner.page, "E2E цель", "Заблокировать");
  check("владелец блокирует пользователя", (await status(target.id)) === "blocked");
  await at(owner.page, "/users");
  await clickIn(owner.page, "E2E цель", "Разблокировать");
  check("владелец разблокирует пользователя", (await status(target.id)) === "active");

  // 2. Обход: кнопка у удалённого аккаунта привязана к "active" — удалённый не должен «ожить».
  await at(owner.page, "/users");
  await clickIn(owner.page, "E2E удалённый", "Разблокировать");
  check("удалённый аккаунт не восстанавливается через action", (await status(deleted.id)) === "deleted");

  // 3. Модератор: страницы и разрешённые разделы — да, блокировка пользователей — нет (сервер, не интерфейс).
  const moderator = await login(MOD);
  check("модератор входит", new URL(moderator.page.url()).pathname === "/");
  check("модератор видит /moderation", (await at(moderator.page, "/moderation")) === "/moderation");
  await at(moderator.page, "/users");
  await clickIn(moderator.page, "E2E цель", "Заблокировать");
  check("модератор НЕ может заблокировать пользователя", (await status(target.id)) === "active");

  // 4. Понижение роли действует сразу, без повторного входа.
  await sql`UPDATE admin_users SET role = 'disabled' WHERE id = ${mod.id}`;
  check("отключённый модератор выброшен на /login сразу", (await at(moderator.page, "/moderation")) === "/login");
  const again = await login(MOD);
  check("отключённый модератор не может войти", new URL(again.page.url()).pathname === "/login");

  // 5. Удаление администратора — немедленный отзыв.
  await sql`UPDATE admin_users SET role = 'moderator' WHERE id = ${mod.id}`;
  const modAgain = await login(MOD);
  check("модератор снова входит после включения", new URL(modAgain.page.url()).pathname === "/");
  await sql`DELETE FROM admin_users WHERE id = ${mod.id}`;
  check("удалённый администратор выброшен на /login сразу", (await at(modAgain.page, "/")) === "/login");

  // 6. Старый формат cookie (без pwv) и поддельная роль в токене не дают доступа.
  const [ownerRow] = await sql`SELECT id, email, role FROM admin_users WHERE email = ${OWNER.email}`;
  const legacy = jwt.sign({ sub: ownerRow.id, email: ownerRow.email, role: "superadmin" }, process.env.ADMIN_SESSION_SECRET, { expiresIn: "12h" });
  const legacyCtx = await browser.newContext();
  await legacyCtx.addCookies([{ name: "ustal_admin_session", value: legacy, domain: "localhost", path: "/", httpOnly: true }]);
  const legacyPage = await legacyCtx.newPage();
  check("старая cookie без pwv → /login (одноразовый повторный вход)", (await at(legacyPage, "/")) === "/login");

  // 7. Смена пароля владельца отзывает его открытую сессию.
  const [{ password_hash: oldHash }] = await sql`SELECT password_hash FROM admin_users WHERE id = ${ownerRow.id}`;
  await sql`UPDATE admin_users SET password_hash = ${await argon2.hash(OWNER.password)} WHERE id = ${ownerRow.id}`;
  check("смена пароля отзывает сессию владельца", (await at(owner.page, "/")) === "/login");
  await sql`UPDATE admin_users SET password_hash = ${oldHash} WHERE id = ${ownerRow.id}`;
  const ownerAgain = await login(OWNER);
  check("владелец снова входит с тем же паролем", new URL(ownerAgain.page.url()).pathname === "/");
} finally {
  await sql`DELETE FROM admin_users WHERE email = ${MOD.email}`;
  await sql`DELETE FROM user_profiles WHERE user_id IN (${target.id}, ${deleted.id})`;
  await sql`DELETE FROM users WHERE id IN (${target.id}, ${deleted.id})`;
  await sql`DELETE FROM cities WHERE id = ${city.id}`;
  await sql.end();
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
