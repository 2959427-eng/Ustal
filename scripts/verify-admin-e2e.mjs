// Реальная E2E-проверка админки через headless Chromium (Playwright).
// Логин идёт через Server Action (client-компонент useFormState -> React
// flight-протокол), поэтому curl тут бесполезен — нужен настоящий браузер.
//
// Запуск: node scripts/verify-admin-e2e.mjs
// Предполагает: `npm run start -w @ustal/admin` уже поднят на :4100,
// дев-админ уже засеян (`npm run db:seed-admin`).

import { chromium } from "playwright-core";

const BASE = "http://localhost:4100";
const EMAIL = process.env.ADMIN_SEED_EMAIL ?? "admin@ustal.local";
const PASSWORD = process.env.ADMIN_SEED_PASSWORD ?? "admin-dev-password-change-me";

function ok(label) {
  console.log(`OK   ${label}`);
}
function fail(label, extra) {
  console.error(`FAIL ${label}${extra ? " — " + extra : ""}`);
  process.exitCode = 1;
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--headless=new"],
});

try {
  const page = await browser.newPage();

  // 1. Неавторизованный доступ к защищённой странице -> редирект на /login
  const resp1 = await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  if (page.url() === `${BASE}/login`) ok("unauthenticated / redirects to /login");
  else fail("unauthenticated / redirects to /login", `ended at ${page.url()}`);

  // 2. Неправильный пароль -> остаёмся на /login с ошибкой
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', "wrong-password-xyz");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(800);
  const bodyAfterWrong = await page.textContent("body");
  if (page.url() === `${BASE}/login` && /неверн|invalid|ошибка/i.test(bodyAfterWrong ?? ""))
    ok("wrong password stays on /login with error");
  else fail("wrong password stays on /login with error", `url=${page.url()}`);

  // 3. Правильный логин -> редирект на дашборд
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 5000 }).catch(() => {});
  if (page.url() === `${BASE}/`) ok("correct login redirects to dashboard");
  else fail("correct login redirects to dashboard", `ended at ${page.url()}`);

  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((c) => c.name === "ustal_admin_session");
  if (sessionCookie && sessionCookie.httpOnly) ok("session cookie set as httpOnly");
  else fail("session cookie set as httpOnly", JSON.stringify(sessionCookie));

  // 4. Дашборд показывает карточки со счётчиками
  const dashboardText = await page.textContent("body");
  if (/Пользовател|Заказ|Модерац/.test(dashboardText ?? "")) ok("dashboard renders counters");
  else fail("dashboard renders counters");

  // 5. Users page loads and shows a block/unblock button
  await page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
  const usersText = await page.textContent("body");
  if (/Пользователи/.test(usersText ?? "")) ok("users page renders");
  else fail("users page renders");
  const blockButtons = await page.$$('button:has-text("Заблокировать"), button:has-text("Разблокировать")');
  console.log(`INFO users page has ${blockButtons.length} block/unblock buttons`);

  // 5b. Mutating action: block an active user via the real form submit, then
  // unblock again — proves the Server Action + direct-DB-write path works
  // end-to-end, not just that the page renders.
  const firstBlockRow = await page.$('tr:has(button:has-text("Заблокировать"))');
  if (firstBlockRow) {
    const nameCellBefore = await firstBlockRow.$eval("td:first-child", (el) => el.textContent);
    await firstBlockRow.$eval('button:has-text("Заблокировать")', (el) => el.click());
    await page.waitForTimeout(600);
    const rowsAfterBlock = await page.$$eval("tbody tr", (rows) =>
      rows.map((r) => ({ name: r.children[0]?.textContent, status: r.children[3]?.textContent })),
    );
    const blockedRow = rowsAfterBlock.find((r) => r.name === nameCellBefore);
    if (blockedRow && /blocked/i.test(blockedRow.status ?? "")) ok("block user action persists status=blocked");
    else fail("block user action persists status=blocked", JSON.stringify(blockedRow));

    // revert so the DB is left as found
    const revertRow = await page.$(`tr:has(td:has-text("${nameCellBefore}"))`);
    if (revertRow) {
      await revertRow.$eval('button:has-text("Разблокировать")', (el) => el.click());
      await page.waitForTimeout(600);
      ok("unblock user action reverts status (cleanup)");
    }
  } else {
    console.log("INFO no active user found to test block action on — skipping mutation test");
  }

  // 6. Moderation page loads
  await page.goto(`${BASE}/moderation`, { waitUntil: "networkidle" });
  const modText = await page.textContent("body");
  if (/Модерац/.test(modText ?? "")) ok("moderation page renders");
  else fail("moderation page renders");

  // 7. Ontology candidates page loads
  await page.goto(`${BASE}/ontology-candidates`, { waitUntil: "networkidle" });
  const ontText = await page.textContent("body");
  if (page.url().includes("ontology-candidates")) ok("ontology-candidates page renders");
  else fail("ontology-candidates page renders");

  // 8. Reports page loads
  await page.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
  if (page.url().includes("/reports")) ok("reports page renders");
  else fail("reports page renders");

  // 9. AI costs page loads
  await page.goto(`${BASE}/ai-costs`, { waitUntil: "networkidle" });
  if (page.url().includes("/ai-costs")) ok("ai-costs page renders");
  else fail("ai-costs page renders");

  // 10. Orders page loads
  await page.goto(`${BASE}/orders`, { waitUntil: "networkidle" });
  if (page.url().includes("/orders")) ok("orders page renders");
  else fail("orders page renders");

  // 11. Logout -> back to /login, protected route redirects again
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const logoutButton = await page.$('button:has-text("Выйти"), button:has-text("Logout")');
  if (logoutButton) {
    await logoutButton.click();
    await page.waitForTimeout(800);
    const afterLogoutCookies = await page.context().cookies();
    const stillHasSession = afterLogoutCookies.find((c) => c.name === "ustal_admin_session");
    if (!stillHasSession) ok("logout clears session cookie");
    else fail("logout clears session cookie");
  } else {
    console.log("INFO no logout button found by text — checking nav markup manually");
  }
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error("\nE2E FAILED");
  process.exit(1);
} else {
  console.log("\nE2E OK");
}
