/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 8 (Жалобы, блокировки, security-фикс
 * /auth/refresh) — тот же принцип, что и Фазы 1-7. Админ-часть (Next.js,
 * прямой доступ к БД, Server Actions) проверяется отдельно headless-браузером
 * в scripts/verify-admin-e2e.mjs, так как логин там идёт через React
 * flight-протокол, а не обычный REST — этому скрипту она не подвластна.
 *   npx tsx scripts/verify-phase8.ts
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../apps/api/src/app.js";
import { getDb, schema } from "../packages/database/src/index.js";

async function register(app: Awaited<ReturnType<typeof buildApp>>, cityId: string, name: string) {
  const phone = `+7900${Math.floor(1000000 + Math.random() * 8999999)}`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name, phone, password: "test-password-123", cityId, acceptedRules: true, acceptedPdn: true },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { accessToken: string; refreshToken: string; userId: string };
}

async function main() {
  const app = await buildApp();
  await app.ready();
  const db = getDb();

  const cities = await db.query.cities.findMany();
  assert.ok(cities.length >= 1);
  const [city] = cities;
  assert.ok(city);

  console.log("1. Настройка: три пользователя (reporter, target, stranger) + один заказ reporter'а");
  const reporter = await register(app, city.id, "Автор жалобы");
  const target = await register(app, city.id, "Цель жалобы");
  const stranger = await register(app, city.id, "Посторонний");

  const orderCreate = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${reporter.accessToken}`, "idempotency-key": "phase8-order-1" },
    payload: { inputType: "text", text: "Нужен мастер по ремонту стиральной машины" },
  });
  assert.equal(orderCreate.statusCode, 201, orderCreate.body);
  const { orderId } = orderCreate.json();
  console.log("   ok");

  console.log("2. POST /reports на заказ -> 201; на несуществующий заказ -> 404; на самого себя (targetType=user) -> 400");
  const reportOrder = await app.inject({
    method: "POST",
    url: "/reports",
    headers: { authorization: `Bearer ${target.accessToken}` },
    payload: { targetType: "order", targetId: orderId, reason: "spam", comment: "Похоже на спам" },
  });
  assert.equal(reportOrder.statusCode, 201, reportOrder.body);
  assert.equal(reportOrder.json().status, "open");

  const reportMissing = await app.inject({
    method: "POST",
    url: "/reports",
    headers: { authorization: `Bearer ${target.accessToken}` },
    payload: { targetType: "order", targetId: "00000000-0000-0000-0000-000000000000", reason: "spam" },
  });
  assert.equal(reportMissing.statusCode, 404, reportMissing.body);

  const reportSelf = await app.inject({
    method: "POST",
    url: "/reports",
    headers: { authorization: `Bearer ${reporter.accessToken}` },
    payload: { targetType: "user", targetId: reporter.userId, reason: "other" },
  });
  assert.equal(reportSelf.statusCode, 400, reportSelf.body);
  console.log("   ok");

  console.log("3. POST /reports на пользователя (targetType=user) -> 201, запись видна в БД со статусом open");
  const reportUser = await app.inject({
    method: "POST",
    url: "/reports",
    headers: { authorization: `Bearer ${stranger.accessToken}` },
    payload: { targetType: "user", targetId: target.userId, reason: "fraud", comment: "Просит предоплату вне платформы" },
  });
  assert.equal(reportUser.statusCode, 201, reportUser.body);
  const reportRow = await db.query.reports.findFirst({ where: eq(schema.reports.id, reportUser.json().id) });
  assert.equal(reportRow?.status, "open");
  assert.equal(reportRow?.targetType, "user");
  console.log("   ok");

  console.log("4. POST /blocks -> 201; повтор -> 200 (идемпотентно, тот же id, не дубль); блокировка себя -> 400; несуществующего -> 404");
  const block1 = await app.inject({
    method: "POST",
    url: "/blocks",
    headers: { authorization: `Bearer ${reporter.accessToken}` },
    payload: { blockedId: target.userId },
  });
  assert.equal(block1.statusCode, 201, block1.body);
  const blockId = block1.json().id as string;

  const block2 = await app.inject({
    method: "POST",
    url: "/blocks",
    headers: { authorization: `Bearer ${reporter.accessToken}` },
    payload: { blockedId: target.userId },
  });
  assert.equal(block2.statusCode, 200, block2.body);
  assert.equal(block2.json().id, blockId, "повторная блокировка не должна создавать дубль");

  const blockRows = await db.query.blocks.findMany({ where: eq(schema.blocks.blockerId, reporter.userId) });
  assert.equal(blockRows.filter((b) => b.blockedId === target.userId).length, 1, "в БД должна быть ровно одна строка");

  const blockSelf = await app.inject({
    method: "POST",
    url: "/blocks",
    headers: { authorization: `Bearer ${reporter.accessToken}` },
    payload: { blockedId: reporter.userId },
  });
  assert.equal(blockSelf.statusCode, 400, blockSelf.body);

  const blockMissing = await app.inject({
    method: "POST",
    url: "/blocks",
    headers: { authorization: `Bearer ${reporter.accessToken}` },
    payload: { blockedId: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(blockMissing.statusCode, 404, blockMissing.body);
  console.log("   ok");

  console.log("5. GET /blocks -> список блокировщика; DELETE /blocks/:id -> 204; чужой DELETE -> 404; повторный DELETE -> 404");
  const listBlocks = await app.inject({ method: "GET", url: "/blocks", headers: { authorization: `Bearer ${reporter.accessToken}` } });
  assert.equal(listBlocks.statusCode, 200);
  assert.ok(listBlocks.json().items.some((b: { id: string }) => b.id === blockId));

  const deleteForeign = await app.inject({
    method: "DELETE",
    url: `/blocks/${blockId}`,
    headers: { authorization: `Bearer ${stranger.accessToken}` },
  });
  assert.equal(deleteForeign.statusCode, 404, deleteForeign.body);

  const deleteOwn = await app.inject({
    method: "DELETE",
    url: `/blocks/${blockId}`,
    headers: { authorization: `Bearer ${reporter.accessToken}` },
  });
  assert.equal(deleteOwn.statusCode, 204, deleteOwn.body);

  const deleteAgain = await app.inject({
    method: "DELETE",
    url: `/blocks/${blockId}`,
    headers: { authorization: `Bearer ${reporter.accessToken}` },
  });
  assert.equal(deleteAgain.statusCode, 404);
  console.log("   ok");

  console.log("6. Security-фикс: /auth/refresh для заблокированного (status=blocked) пользователя -> 401, сессия отзывается");
  const victim = await register(app, city.id, "Жертва блокировки");

  const refreshBeforeBlock = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: victim.refreshToken },
  });
  assert.equal(refreshBeforeBlock.statusCode, 200, refreshBeforeBlock.body);
  const rotatedRefreshToken = refreshBeforeBlock.json().refreshToken as string;

  await db.update(schema.users).set({ status: "blocked" }).where(eq(schema.users.id, victim.userId));

  const refreshAfterBlock = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: rotatedRefreshToken },
  });
  assert.equal(refreshAfterBlock.statusCode, 401, refreshAfterBlock.body);
  assert.equal(refreshAfterBlock.json().error.code, "invalid_refresh_token");

  console.log("   ok (до фикса заблокированный пользователь мог бы бесконечно получать новые access token'ы через старый refresh)");

  console.log("7. Повторный /auth/refresh тем же (уже отозванным) токеном -> 401 в любом случае");
  const refreshAgain = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: rotatedRefreshToken },
  });
  assert.equal(refreshAgain.statusCode, 401, refreshAgain.body);
  console.log("   ok");

  await app.close();
  console.log(
    "\n✅ Фаза 8 (backend) проверена сквозным сценарием: POST /reports (заказ/пользователь, self-report -> 400, несуществующая цель -> 404) -> POST /blocks идемпотентно (повтор -> 200 тот же id, self-block -> 400, несуществующий -> 404) -> GET/DELETE /blocks с проверкой владения -> security-фикс /auth/refresh проверяет users.status и отзывает сессию блокированного. Admin-приложение (Next.js, прямой доступ к БД) проверено отдельно: scripts/verify-admin-e2e.mjs (headless Chromium, реальный логин через Server Action, мутирующее действие block/unblock).",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
