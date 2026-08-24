/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 6 («Договорились» и закрытие заказа) — тот
 * же принцип, что и Фазы 1-5.
 *   npx tsx scripts/verify-phase6.ts
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../apps/api/src/app.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { getDb, schema } from "../packages/database/src/index.js";

async function register(app: Awaited<ReturnType<typeof buildApp>>, cityId: string, name: string) {
  const phone = `+7900${Math.floor(1000000 + Math.random() * 8999999)}`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name, phone, password: "test-password-123", cityId, acceptedRules: true, acceptedPdn: true },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { accessToken: string; userId: string };
}

async function createPublishedOrder(
  app: Awaited<ReturnType<typeof buildApp>>,
  boss: Awaited<ReturnType<typeof getBoss>>,
  token: string,
  text: string,
  idemKey: string,
) {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": idemKey },
    payload: { inputType: "text", text },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { orderId } = create.json();

  const [job] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(job, "order_extraction job not found");
  await handleOrderExtraction(job as never);
  await boss.complete(job.id);

  const publish = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/publish`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(publish.statusCode, 200, publish.body);
  const [matchJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
  if (matchJob) await boss.complete(matchJob.id);

  return orderId as string;
}

async function respond(app: Awaited<ReturnType<typeof buildApp>>, orderId: string, token: string) {
  const res = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function unlock(app: Awaited<ReturnType<typeof buildApp>>, orderId: string, authorToken: string, responseId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/contact-unlocks`,
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { responseId },
  });
  assert.equal(res.statusCode, 201, res.body);
}

async function drainNotifications(boss: Awaited<ReturnType<typeof getBoss>>) {
  // Уведомления в этом скрипте не проверяются по содержимому push'а (это уже
  // покрыто scripts/verify-phase5.ts) — просто вычищаем очередь между шагами,
  // чтобы boss.fetch в следующей проверке не подхватил задачу от предыдущей.
  for (;;) {
    const [job] = (await boss.fetch(JOB_TYPES.NOTIFICATION_DISPATCH, 1)) ?? [];
    if (!job) break;
    await boss.complete(job.id);
  }
}

async function main() {
  const app = await buildApp();
  await app.ready();
  const db = getDb();
  const boss = await getBoss();
  await boss.clearStorage();

  const cities = await db.query.cities.findMany();
  assert.ok(cities.length >= 1);
  const [city] = cities;
  assert.ok(city);

  console.log("1. Настройка: автор + исполнители A/B/C откликаются на опубликованный заказ");
  const author = await register(app, city.id, "Автор Заказа");
  const candA = await register(app, city.id, "Исполнитель A");
  const candB = await register(app, city.id, "Исполнитель B");
  const candC = await register(app, city.id, "Исполнитель C");
  const orderId = await createPublishedOrder(app, boss, author.accessToken, "Нужна помощь с переездом, три комнаты мебели", "assign-order-1");
  const responseAId = await respond(app, orderId, candA.accessToken);
  const responseBId = await respond(app, orderId, candB.accessToken);
  const responseCId = await respond(app, orderId, candC.accessToken);
  await drainNotifications(boss);
  console.log("   ok, orderId =", orderId);

  console.log("2. Автор раскрывает контакты A и B (не C)");
  await unlock(app, orderId, author.accessToken, responseAId);
  await unlock(app, orderId, author.accessToken, responseBId);
  await drainNotifications(boss);
  console.log("   ok");

  console.log("3. Назначение C без раскрытого контакта -> 409 contact_not_unlocked");
  const assignCNoUnlock = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseCId },
  });
  assert.equal(assignCNoUnlock.statusCode, 409, assignCNoUnlock.body);
  assert.equal(assignCNoUnlock.json().error.code, "contact_not_unlocked");
  console.log("   ok");

  console.log("4. Назначение A -> 201, заказ published -> negotiating");
  const assignA = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseAId },
  });
  assert.equal(assignA.statusCode, 201, assignA.body);
  await drainNotifications(boss);
  const orderAfterAssignA = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  assert.equal(orderAfterAssignA?.status, "negotiating");
  console.log("   ok, order.status =", orderAfterAssignA?.status);

  console.log("5. Повторное назначение A -> 409 already_selected (уникальность order+executor)");
  const assignAAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseAId },
  });
  assert.equal(assignAAgain.statusCode, 409, assignAAgain.body);
  assert.equal(assignAAgain.json().error.code, "already_selected");
  console.log("   ok");

  console.log("6. Новый отклик исполнителя D пока заказ в negotiating -> всё ещё принимается (201)");
  const candD = await register(app, city.id, "Исполнитель D");
  const responseDId = await respond(app, orderId, candD.accessToken);
  await drainNotifications(boss);
  console.log("   ok");

  console.log("7. Множественные назначения без счётчика: раскрываем контакт D и назначаем D и B");
  await unlock(app, orderId, author.accessToken, responseDId);
  await drainNotifications(boss);
  const assignD = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseDId },
  });
  assert.equal(assignD.statusCode, 201, assignD.body);
  const assignB = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseBId },
  });
  assert.equal(assignB.statusCode, 201, assignB.body);
  await drainNotifications(boss);
  const assignmentsRows = await db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.orderId, orderId) });
  assert.equal(assignmentsRows.length, 3, "ожидались 3 назначения (A, D, B) без каких-либо счётчиков-ограничений");
  console.log("   ok, назначений:", assignmentsRows.length);

  console.log("8. PATCH уже выбранного отклика (A) -> 409 already_selected (нельзя менять отклик после выбора)");
  const patchSelected = await app.inject({
    method: "PATCH",
    url: `/responses/${responseAId}`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: { comment: "поздно менять" },
  });
  assert.equal(patchSelected.statusCode, 409, patchSelected.body);
  assert.equal(patchSelected.json().error.code, "already_selected");
  console.log("   ok");

  console.log("9. GET /orders/:id/responses (автор) — 4 отклика, корректные isContactUnlocked/assignmentStatus");
  const listResponses = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(listResponses.statusCode, 200);
  const items = listResponses.json().items as { executorId: string; isContactUnlocked: boolean; assignmentStatus: string | null }[];
  assert.equal(items.length, 4);
  const byExecutor = new Map(items.map((i) => [i.executorId, i]));
  assert.equal(byExecutor.get(candA.userId)?.assignmentStatus, "selected");
  assert.equal(byExecutor.get(candB.userId)?.assignmentStatus, "selected");
  assert.equal(byExecutor.get(candD.userId)?.assignmentStatus, "selected");
  assert.equal(byExecutor.get(candC.userId)?.assignmentStatus, null);
  assert.equal(byExecutor.get(candC.userId)?.isContactUnlocked, false);
  console.log("   ok");

  console.log("10. Закрытие заказа -> 200, C (единственный не выбранный активный отклик) -> not_selected");
  const close = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/close`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(close.statusCode, 200, close.body);
  assert.equal(close.json().notSelectedCount, 1);
  await drainNotifications(boss);

  const orderAfterClose = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  assert.equal(orderAfterClose?.status, "closed");
  assert.ok(orderAfterClose?.closedAt);

  const responseC = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseCId) });
  assert.equal(responseC?.status, "not_selected");
  const responseA = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseAId) });
  assert.equal(responseA?.status, "active", "выбранные отклики остаются active — назначение отслеживается отдельно");
  console.log("   ok, order.status =", orderAfterClose?.status, "responseC.status =", responseC?.status);

  console.log("11. Уведомление 'not_selected' долетело до C");
  const notifsC = await app.inject({
    method: "GET",
    url: "/notifications",
    headers: { authorization: `Bearer ${candC.accessToken}` },
  });
  assert.equal(notifsC.statusCode, 200);
  assert.ok(notifsC.json().items.some((n: { type: string }) => n.type === "not_selected"));
  console.log("   ok");

  console.log("12. Новый отклик после закрытия -> 409; повторное закрытие -> 409; назначение после закрытия -> 409");
  const respAfterClose = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${(await register(app, city.id, "Опоздавший")).accessToken}` },
    payload: {},
  });
  assert.equal(respAfterClose.statusCode, 409);

  const closeAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/close`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(closeAgain.statusCode, 409);

  const assignAfterClose = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseCId },
  });
  assert.equal(assignAfterClose.statusCode, 409);
  console.log("   ok");

  console.log("13. Чужой (не автор) не может назначать/закрывать — 404");
  const foreignOrder = await createPublishedOrder(app, boss, candA.accessToken, "Проверка авторства", "assign-order-2");
  await drainNotifications(boss); // возможный matching_run уже вычерпан createPublishedOrder; на всякий случай.
  const respForeign = await respond(app, foreignOrder, candB.accessToken);
  await unlock(app, foreignOrder, candA.accessToken, respForeign);
  await drainNotifications(boss);

  const foreignAssign = await app.inject({
    method: "POST",
    url: `/orders/${foreignOrder}/assignments`,
    headers: { authorization: `Bearer ${candC.accessToken}` },
    payload: { responseId: respForeign },
  });
  assert.equal(foreignAssign.statusCode, 404);

  const foreignClose = await app.inject({
    method: "POST",
    url: `/orders/${foreignOrder}/close`,
    headers: { authorization: `Bearer ${candC.accessToken}` },
  });
  assert.equal(foreignClose.statusCode, 404);
  console.log("   ok");

  await app.close();
  console.log(
    "\n✅ Фаза 6 проверена сквозным сценарием: назначение требует раскрытого контакта -> первое назначение переводит заказ в negotiating -> уникальность назначения -> отклики всё ещё принимаются в negotiating -> множественные назначения без счётчика -> выбранный отклик больше нельзя менять -> закрытие переводит невыбранные активные отклики в not_selected с уведомлением -> закрытие блокирует новые отклики/повторное закрытие/новые назначения -> авторство проверяется (404 чужому).",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
