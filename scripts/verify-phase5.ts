/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 5 (Отклики и обсуждение) — тот же принцип,
 * что и Фазы 1-4.
 *   npx tsx scripts/verify-phase5.ts
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../apps/api/src/app.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { handleNotificationDispatch } from "../apps/worker/src/handlers/notification-dispatch.js";
import { getDb, schema } from "../packages/database/src/index.js";
import { getRuntimeConfig } from "../packages/config/src/index.js";

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
  // publish тоже ставит matching_run — забираем и отбрасываем, чтобы не мешал очереди.
  const [matchJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
  if (matchJob) await boss.complete(matchJob.id);

  return orderId as string;
}

async function popAndRunNotificationJob(boss: Awaited<ReturnType<typeof getBoss>>) {
  const [job] = (await boss.fetch(JOB_TYPES.NOTIFICATION_DISPATCH, 1)) ?? [];
  assert.ok(job, "notification_dispatch job not found");
  const result = await handleNotificationDispatch(job as never);
  await boss.complete(job.id);
  return result;
}

async function main() {
  // Понижаем business-лимит contact-unlocks для этого прогона, чтобы не
  // упереться в отдельный, не связанный с ним технический IP-лимит запросов
  // (@fastify/rate-limit, 100/мин, apps/api/src/app.ts) при добирании до
  // настоящего CONTACT_UNLOCKS_PER_HOUR (по умолчанию 30, что потребовало бы
  // ~90 HTTP-запросов подряд только для этого шага). Должно быть установлено
  // до первого вызова loadEnv() (который кеширует process.env один раз за
  // процесс) — то есть до buildApp().
  process.env.CONTACT_UNLOCKS_PER_HOUR = "3";
  const app = await buildApp();
  await app.ready();
  const db = getDb();
  const boss = await getBoss();
  await boss.clearStorage();

  const cities = await db.query.cities.findMany();
  assert.ok(cities.length >= 1);
  const [city] = cities;
  assert.ok(city);

  console.log("1. Настройка: автор + 2 исполнителя, заказ опубликован");
  const author = await register(app, city.id, "Автор Заказа");
  const candA = await register(app, city.id, "Исполнитель A");
  const candB = await register(app, city.id, "Исполнитель B");
  const orderId = await createPublishedOrder(app, boss, author.accessToken, "Нужно перевезти диван на новую квартиру", "resp-order-1");
  console.log("   ok, orderId =", orderId);

  console.log("2. Автор регистрирует устройство для push (мок-провайдер, PUSH_PROVIDER=mock по умолчанию)");
  const authorDevice = await app.inject({
    method: "POST",
    url: "/devices",
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { expoPushToken: `ExponentPushToken[author-${Date.now()}]`, platform: "android" },
  });
  assert.equal(authorDevice.statusCode, 200, authorDevice.body);
  console.log("   ok");

  console.log("3. Автор не может откликнуться на свой заказ — 403");
  const selfResponse = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: {},
  });
  assert.equal(selfResponse.statusCode, 403, selfResponse.body);
  console.log("   ok");

  console.log("4. Исполнитель A откликается со встречной ценой -> 201, автору летит уведомление + push");
  const respA = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: { offeredPriceMinor: 250000, comment: "Могу сегодня вечером" },
  });
  assert.equal(respA.statusCode, 201, respA.body);
  const responseAId = respA.json().id as string;

  const dispatchResult1 = await popAndRunNotificationJob(boss);
  assert.equal((dispatchResult1 as { devicesCount: number }).devicesCount, 1);
  assert.equal((dispatchResult1 as { sent: number }).sent, 1);
  console.log("   ok,", dispatchResult1);

  console.log("5. Повторный отклик того же исполнителя на тот же заказ -> 409 (уникальный активный отклик)");
  const dupResponse = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: {},
  });
  assert.equal(dupResponse.statusCode, 409, dupResponse.body);
  console.log("   ok");

  console.log("6. GET /orders/:id/responses (автор) — виден отклик A, isContactUnlocked=false");
  const listResponses = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(listResponses.statusCode, 200);
  const listBody = listResponses.json();
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0].isContactUnlocked, false);
  console.log("   ok");

  console.log("7. Чужой не может увидеть чужой список откликов — 404 (не 403)");
  const foreignList = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${candB.accessToken}` },
  });
  assert.equal(foreignList.statusCode, 404);
  console.log("   ok");

  console.log("8. PATCH /responses/:id — владелец правит свой отклик; чужой (B) получает 404");
  const patchOwn = await app.inject({
    method: "PATCH",
    url: `/responses/${responseAId}`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: { comment: "Уточнение: подъеду к 19:00" },
  });
  assert.equal(patchOwn.statusCode, 200, patchOwn.body);
  assert.equal(patchOwn.json().comment, "Уточнение: подъеду к 19:00");

  const patchForeign = await app.inject({
    method: "PATCH",
    url: `/responses/${responseAId}`,
    headers: { authorization: `Bearer ${candB.accessToken}` },
    payload: { comment: "чужое" },
  });
  assert.equal(patchForeign.statusCode, 404);
  console.log("   ok");

  console.log("9. «Обсудить заказ»: автор раскрывает контакт исполнителя A -> 201, executor получает уведомление + push");
  const candADevice = await app.inject({
    method: "POST",
    url: "/devices",
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: { expoPushToken: `ExponentPushToken[candA-${Date.now()}]`, platform: "ios" },
  });
  assert.equal(candADevice.statusCode, 200);

  const unlock = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/contact-unlocks`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseAId },
  });
  assert.equal(unlock.statusCode, 201, unlock.body);

  const dispatchResult2 = await popAndRunNotificationJob(boss);
  assert.equal((dispatchResult2 as { sent: number }).sent, 1);
  console.log("   ok,", dispatchResult2);

  console.log("10. Повторное раскрытие того же (order, executor) -> 200 идемпотентно, без дубля в БД");
  const unlockAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/contact-unlocks`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: responseAId },
  });
  assert.equal(unlockAgain.statusCode, 200, unlockAgain.body);
  const unlockRows = await db.query.contactUnlocks.findMany({
    where: and(eq(schema.contactUnlocks.orderId, orderId), eq(schema.contactUnlocks.executorId, candA.userId)),
  });
  assert.equal(unlockRows.length, 1, "повторный unlock создал дубль");
  console.log("   ok");

  console.log("11. GET /orders/:id/contacts/:userId — обе стороны видят телефон друг друга, посторонний (B) — 404");
  const contactForAuthor = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/contacts/${candA.userId}`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(contactForAuthor.statusCode, 200, contactForAuthor.body);
  assert.ok(contactForAuthor.json().phone);

  const contactForExecutor = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/contacts/${author.userId}`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
  });
  assert.equal(contactForExecutor.statusCode, 200, contactForExecutor.body);
  assert.ok(contactForExecutor.json().phone);
  assert.equal(contactForExecutor.json().whatsappPhone, null, "whatsappPhone не задавали — должен быть null");

  const contactForStranger = await app.inject({
    method: "GET",
    url: `/orders/${orderId}/contacts/${candA.userId}`,
    headers: { authorization: `Bearer ${candB.accessToken}` },
  });
  assert.equal(contactForStranger.statusCode, 404);
  console.log("   ok");

  console.log("12. DELETE /responses/:id (отзыв) -> 204, статус withdrawn, повторный отклик того же исполнителя снова возможен");
  const withdraw = await app.inject({
    method: "DELETE",
    url: `/responses/${responseAId}`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
  });
  assert.equal(withdraw.statusCode, 204, withdraw.body);
  const afterWithdraw = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseAId) });
  assert.equal(afterWithdraw?.status, "withdrawn");

  const respAgain = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: {},
  });
  assert.equal(respAgain.statusCode, 201, respAgain.body);
  console.log("   ok");

  console.log("13. GET /my/responses (A) и GET /my/orders (автор) — свои списки видны");
  const myResponses = await app.inject({
    method: "GET",
    url: "/my/responses",
    headers: { authorization: `Bearer ${candA.accessToken}` },
  });
  assert.equal(myResponses.statusCode, 200);
  assert.ok(myResponses.json().items.length >= 2, "ожидались минимум 2 отклика A (withdrawn + новый)");

  const myOrders = await app.inject({
    method: "GET",
    url: "/my/orders",
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(myOrders.statusCode, 200);
  assert.ok(myOrders.json().items.some((o: { id: string }) => o.id === orderId));
  console.log("   ok");

  console.log("14. GET /notifications (автор) — уведомление о первом отклике видно, помечается прочитанным");
  const notifs = await app.inject({
    method: "GET",
    url: "/notifications",
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(notifs.statusCode, 200);
  const firstNotif = notifs.json().items[0];
  assert.ok(firstNotif);
  assert.equal(firstNotif.readAt, null);
  const markRead = await app.inject({
    method: "POST",
    url: `/notifications/${firstNotif.id}/read`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(markRead.statusCode, 204);
  const notifsAfter = await app.inject({
    method: "GET",
    url: "/notifications",
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  const readNotif = notifsAfter.json().items.find((n: { id: string }) => n.id === firstNotif.id);
  assert.ok(readNotif.readAt, "уведомление должно быть помечено прочитанным");
  console.log("   ok");

  console.log("15. Отмена заказа блокирует новые отклики (409) и дальнейшую правку существующих (409)");
  const cancel = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/cancel`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(cancel.statusCode, 204, cancel.body);

  const respAfterCancel = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/responses`,
    headers: { authorization: `Bearer ${candB.accessToken}` },
    payload: {},
  });
  assert.equal(respAfterCancel.statusCode, 409, respAfterCancel.body);

  const respAgainId = respAgain.json().id as string;
  const patchAfterCancel = await app.inject({
    method: "PATCH",
    url: `/responses/${respAgainId}`,
    headers: { authorization: `Bearer ${candA.accessToken}` },
    payload: { comment: "поздно" },
  });
  assert.equal(patchAfterCancel.statusCode, 409, patchAfterCancel.body);
  console.log("   ok");

  console.log("16. Rate limit contact-unlocks: добираем до CONTACT_UNLOCKS_PER_HOUR отдельными (заказ, исполнитель) парами");
  const config = getRuntimeConfig();
  const limit = config.rateLimits.contactUnlocksPerHour;
  const rlOrderId = await createPublishedOrder(app, boss, author.accessToken, "Нужна помощь с генеральной уборкой квартиры", "resp-order-rl");

  // Один unlock уже потрачен на шаге 9 в этом же часовом окне у этого автора.
  const alreadySpent = 1;
  let succeeded = alreadySpent;
  for (let i = 0; succeeded < limit; i++) {
    const cand = await register(app, city.id, `RL-исполнитель ${i}`);
    const resp = await app.inject({
      method: "POST",
      url: `/orders/${rlOrderId}/responses`,
      headers: { authorization: `Bearer ${cand.accessToken}` },
      payload: {},
    });
    assert.equal(resp.statusCode, 201, resp.body);
    const unlockAttempt = await app.inject({
      method: "POST",
      url: `/orders/${rlOrderId}/contact-unlocks`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { responseId: resp.json().id },
    });
    assert.equal(unlockAttempt.statusCode, 201, `unlock #${succeeded + 1}/${limit} должен пройти: ${unlockAttempt.body}`);
    succeeded += 1;
  }
  console.log(`   ok, ${succeeded} успешных unlock'ов у автора за час (лимит ${limit})`);

  const overLimitCand = await register(app, city.id, "RL-исполнитель over-limit");
  const overLimitResp = await app.inject({
    method: "POST",
    url: `/orders/${rlOrderId}/responses`,
    headers: { authorization: `Bearer ${overLimitCand.accessToken}` },
    payload: {},
  });
  assert.equal(overLimitResp.statusCode, 201, overLimitResp.body);
  const overLimitUnlock = await app.inject({
    method: "POST",
    url: `/orders/${rlOrderId}/contact-unlocks`,
    headers: { authorization: `Bearer ${author.accessToken}` },
    payload: { responseId: overLimitResp.json().id },
  });
  assert.equal(overLimitUnlock.statusCode, 429, overLimitUnlock.body);
  console.log("   ok, лимит сработал (429) на", limit + 1, "-й попытке");

  await app.close();
  console.log(
    "\n✅ Фаза 5 проверена сквозным сценарием: responses (создание, уникальность активного отклика, автор не может откликнуться на свой заказ, список автора, чужой список скрыт, PATCH/DELETE только владельцем) -> notification_dispatch + push (мок) -> contact-unlocks (идемпотентность, обе стороны видят телефон, посторонний — 404, technical rate limit) -> my/orders, my/responses -> notifications (список, пометка прочитанным) -> отмена заказа блокирует новые/правку существующих откликов.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
