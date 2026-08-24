/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 7 (Результат работы и двусторонние отзывы) —
 * тот же принцип, что и Фазы 1-6.
 *   npx tsx scripts/verify-phase7.ts
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

async function drainNotifications(boss: Awaited<ReturnType<typeof getBoss>>) {
  for (;;) {
    const [job] = (await boss.fetch(JOB_TYPES.NOTIFICATION_DISPATCH, 1)) ?? [];
    if (!job) break;
    await boss.complete(job.id);
  }
}

async function setUpAssignedOrder(
  app: Awaited<ReturnType<typeof buildApp>>,
  boss: Awaited<ReturnType<typeof getBoss>>,
  authorToken: string,
  executor: { accessToken: string; userId: string },
  text: string,
  idemKey: string,
) {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${authorToken}`, "idempotency-key": idemKey },
    payload: { inputType: "text", text },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { orderId } = create.json();

  const [job] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(job);
  await handleOrderExtraction(job as never);
  await boss.complete(job.id);

  const publish = await app.inject({ method: "POST", url: `/orders/${orderId}/publish`, headers: { authorization: `Bearer ${authorToken}` } });
  assert.equal(publish.statusCode, 200, publish.body);
  const [matchJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
  if (matchJob) await boss.complete(matchJob.id);

  const resp = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${executor.accessToken}` },
    payload: {},
  });
  assert.equal(resp.statusCode, 201, resp.body);
  const responseId = resp.json().id as string;

  const unlock = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/contact-unlocks`,
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { responseId },
  });
  assert.equal(unlock.statusCode, 201, unlock.body);

  const assign = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/assignments`,
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { responseId },
  });
  assert.equal(assign.statusCode, 201, assign.body);
  await drainNotifications(boss);

  return { orderId: orderId as string, assignmentId: assign.json().id as string };
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

  console.log("1. Настройка: автор, исполнитель A (успешный заказ) и исполнитель B (незавершённый заказ)");
  const author = await register(app, city.id, "Автор Заказа");
  const execA = await register(app, city.id, "Исполнитель A");
  const execB = await register(app, city.id, "Исполнитель B");
  const stranger = await register(app, city.id, "Посторонний");

  const orderA = await setUpAssignedOrder(app, boss, author.accessToken, execA, "Нужна генеральная уборка квартиры", "review-order-a");
  const orderB = await setUpAssignedOrder(app, boss, author.accessToken, execB, "Нужно перевезти коробки на новую квартиру", "review-order-b");
  console.log("   ok");

  console.log("2. complete(orderA, execA) -> статус completed, исполнитель уведомлён");
  const complete = await app.inject({
    method: "POST",
    url: `/orders/${orderA.orderId}/assignments/${orderA.assignmentId}/complete`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(complete.statusCode, 200, complete.body);
  await drainNotifications(boss);
  const assignmentARow = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, orderA.assignmentId) });
  assert.equal(assignmentARow?.status, "completed");
  assert.ok(assignmentARow?.completedAt);
  console.log("   ok");

  console.log("3. Повторный complete -> 409 (уже завершено)");
  const completeAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderA.orderId}/assignments/${orderA.assignmentId}/complete`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(completeAgain.statusCode, 409, completeAgain.body);
  console.log("   ok");

  console.log("4. not-completed(orderB, execB) с причиной -> статус not_completed, причина сохранена, completedAt не заполняется");
  const notCompleted = await app.inject({
    method: "POST",
    url: `/orders/${orderB.orderId}/assignments/${orderB.assignmentId}/not-completed`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { reason: "Исполнитель не приехал" },
  });
  assert.equal(notCompleted.statusCode, 200, notCompleted.body);
  await drainNotifications(boss);
  const assignmentBRow = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, orderB.assignmentId) });
  assert.equal(assignmentBRow?.status, "not_completed");
  assert.equal(assignmentBRow?.notCompletedReason, "Исполнитель не приехал");
  assert.equal(assignmentBRow?.completedAt, null);
  console.log("   ok");

  console.log("5. Повторный not-completed -> 409; чужой (не автор) не может complete/not-completed -> 404");
  const notCompletedAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderB.orderId}/assignments/${orderB.assignmentId}/not-completed`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: {},
  });
  assert.equal(notCompletedAgain.statusCode, 409);

  const foreignComplete = await app.inject({
    method: "POST",
    url: `/orders/${orderA.orderId}/assignments/${orderA.assignmentId}/complete`,
    headers: { authorization: `Bearer ${stranger.accessToken}` },
  });
  assert.equal(foreignComplete.statusCode, 404);
  console.log("   ok");

  console.log("6. POST /reviews: автор -> execA (завершённая работа) -> 201; execA -> автор -> 201 (независимое направление)");
  const reviewAuthorToA = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { toUserId: execA.userId, orderId: orderA.orderId, rating: 5, text: "Отлично поработал" },
  });
  assert.equal(reviewAuthorToA.statusCode, 201, reviewAuthorToA.body);
  const reviewId = reviewAuthorToA.json().id as string;

  const reviewAToAuthor = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${execA.accessToken}` },
    payload: { toUserId: author.userId, orderId: orderA.orderId, rating: 4, text: "Хороший заказчик" },
  });
  assert.equal(reviewAToAuthor.statusCode, 201, reviewAToAuthor.body);
  assert.notEqual(reviewAToAuthor.json().id, reviewId, "отзывы в разных направлениях — разные записи");
  console.log("   ok");

  console.log("7. Повторный POST /reviews (та же пара, тот же заказ) -> 200, обновление, а не дубль (UNIQUE from,to)");
  const reviewAgain = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { toUserId: execA.userId, orderId: orderA.orderId, rating: 3, text: "Пересмотрел оценку" },
  });
  assert.equal(reviewAgain.statusCode, 200, reviewAgain.body);
  assert.equal(reviewAgain.json().id, reviewId);
  assert.equal(reviewAgain.json().rating, 3);
  const reviewRowsCount = await db.query.reviews.findMany({ where: eq(schema.reviews.fromUserId, author.userId) });
  assert.equal(reviewRowsCount.filter((r) => r.toUserId === execA.userId).length, 1, "не должно быть дубля отзыва в БД");
  console.log("   ok");

  console.log("8. PATCH /reviews/:id — владелец правит; чужой получает 404");
  const patchOwn = await app.inject({
    method: "PATCH",
    url: `/reviews/${reviewId}`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { rating: 5, text: "Пересмотрел оценку ещё раз — 5 звёзд" },
  });
  assert.equal(patchOwn.statusCode, 200, patchOwn.body);
  assert.equal(patchOwn.json().rating, 5);

  const patchForeign = await app.inject({
    method: "PATCH",
    url: `/reviews/${reviewId}`,
    headers: { authorization: `Bearer ${stranger.accessToken}` },
    payload: { rating: 1 },
  });
  assert.equal(patchForeign.statusCode, 404);
  console.log("   ok");

  console.log("9. Отзыв без завершённой совместной работы -> 403 not_eligible (B не был завершён, только not_completed)");
  const reviewNotEligible = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { toUserId: execB.userId, orderId: orderB.orderId, rating: 5 },
  });
  assert.equal(reviewNotEligible.statusCode, 403, reviewNotEligible.body);
  assert.equal(reviewNotEligible.json().error.code, "not_eligible");
  console.log("   ok");

  console.log("10. Отзыв постороннему, не связанному с этим заказом вообще -> 403 not_eligible");
  const reviewStranger = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { toUserId: stranger.userId, orderId: orderA.orderId, rating: 5 },
  });
  assert.equal(reviewStranger.statusCode, 403, reviewStranger.body);
  console.log("   ok");

  console.log("11. Отзыв самому себе -> 400");
  const reviewSelf = await app.inject({
    method: "POST",
    url: "/reviews",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { toUserId: author.userId, orderId: orderA.orderId, rating: 5 },
  });
  assert.equal(reviewSelf.statusCode, 400, reviewSelf.body);
  console.log("   ok");

  await app.close();
  console.log(
    "\n✅ Фаза 7 проверена сквозным сценарием: complete -> assignment.completed (+уведомление, повтор -> 409) -> not-completed с причиной -> assignment.not_completed (completedAt не заполняется, повтор -> 409) -> авторство проверяется (404 чужому) -> отзывы в обе стороны -> повторный отзыв той же паре обновляет, а не дублирует (UNIQUE from,to) -> PATCH только владельцем -> отзыв без завершённой совместной работы/постороннему/себе -> 403/400.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
