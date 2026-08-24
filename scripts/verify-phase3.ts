/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 3 (Заказы) — тот же принцип, что и Фазы 1/2.
 *   npx tsx scripts/verify-phase3.ts
 */
import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { getDb, schema } from "../packages/database/src/index.js";
import { eq } from "drizzle-orm";

async function registerUser(app: Awaited<ReturnType<typeof buildApp>>, cityId: string) {
  const phone = `+7900${Math.floor(1000000 + Math.random() * 8999999)}`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      name: "Заказчик Тестов",
      phone,
      password: "test-password-123",
      cityId,
      acceptedRules: true,
      acceptedPdn: true,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { accessToken: string; userId: string };
}

async function main() {
  const app = await buildApp();
  await app.ready();
  const db = getDb();
  const boss = await getBoss();
  await boss.clearStorage();

  const city = (await db.query.cities.findMany())[0];
  assert.ok(city, "seed cities отсутствуют — запустите npm run db:seed");

  console.log("1. Регистрация автора заказа");
  const { accessToken } = await registerUser(app, city.id);
  console.log("   ok");

  console.log("2. POST /orders без Idempotency-Key — 400");
  const noKey = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { inputType: "text", text: "Нужно перевезти диван из одной квартиры в другую, есть подъезд без лифта" },
  });
  assert.equal(noKey.statusCode, 400);
  console.log("   ok");

  console.log("3. POST /orders (обычный, нерегулируемый заказ) — 201, draft->processing");
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${accessToken}`, "idempotency-key": "order-key-1" },
    payload: { inputType: "text", text: "Нужно перевезти диван из одной квартиры в другую, есть подъезд без лифта" },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { orderId } = create.json();
  console.log("   ok, orderId =", orderId);

  console.log("4. Повтор с тем же ключом и телом — идемпотентный replay");
  const replay = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${accessToken}`, "idempotency-key": "order-key-1" },
    payload: { inputType: "text", text: "Нужно перевезти диван из одной квартиры в другую, есть подъезд без лифта" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().orderId, orderId);
  console.log("   ok");

  console.log("5. GET /orders/:id сразу после создания — status=processing, moderationStatus=pending");
  const beforeExtraction = await app.inject({
    method: "GET",
    url: `/orders/${orderId}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(beforeExtraction.statusCode, 200);
  assert.equal(beforeExtraction.json().status, "processing");
  console.log("   ok");

  console.log("6. Публикация ДО завершения extraction — 409 (moderation ещё pending)");
  const earlyPublish = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/publish`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(earlyPublish.statusCode, 409, earlyPublish.body);
  console.log("   ok");

  console.log("7. Забираем и выполняем order_extraction job (MockAIProvider)");
  const [job] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(job, "job не найден в очереди");
  assert.equal(job.data.orderId, orderId);
  const jobResult = await handleOrderExtraction(job as never);
  await boss.complete(job.id);
  console.log("   ok,", jobResult);
  assert.equal(jobResult.moderationDecision, "allow"); // mock всегда allow, текст не регулируемый
  assert.equal(jobResult.status, "processing"); // allow не публикует автоматически

  console.log("8. GET /orders/:id после extraction — normalizedTitle заполнен, moderationStatus=allow");
  const afterExtraction = await app.inject({
    method: "GET",
    url: `/orders/${orderId}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const orderAfter = afterExtraction.json();
  assert.equal(orderAfter.moderationStatus, "allow");
  assert.ok(orderAfter.normalizedTitle, "normalizedTitle не заполнен");
  console.log("   ok, normalizedTitle =", orderAfter.normalizedTitle);

  console.log("9. order_embeddings и ai_runs записаны");
  const embeddingRow = await db.query.orderEmbeddings.findFirst({ where: eq(schema.orderEmbeddings.orderId, orderId) });
  assert.ok(embeddingRow?.embedding && embeddingRow.embedding.length === 1536);
  const aiRuns = await db.query.aiRuns.findMany({ where: eq(schema.aiRuns.traceId, job.id) });
  assert.ok(aiRuns.some((r) => r.operationType === "order_extraction"));
  assert.ok(aiRuns.some((r) => r.operationType === "order_embedding"));
  console.log("   ok,", aiRuns.length, "ai_runs записей, embedding dim =", embeddingRow?.embedding?.length);

  console.log("10. Теперь публикация должна пройти — 200, status=published");
  const publish = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/publish`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(publish.statusCode, 200, publish.body);
  assert.equal(publish.json().status, "published");
  console.log("   ok");

  console.log("11. Повторная публикация уже опубликованного — 409 (invalid_status)");
  const republish = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/publish`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(republish.statusCode, 409);
  console.log("   ok");

  console.log("12. Отмена опубликованного заказа — 204, status=cancelled");
  const cancel = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/cancel`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(cancel.statusCode, 204, cancel.body);
  const afterCancel = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  assert.equal(afterCancel?.status, "cancelled");
  console.log("   ok");

  console.log("13. Регулируемый / рискованный заказ (ключевое слово 'оружие') — жёсткий rule-block -> moderation_hold");
  const { accessToken: token2 } = await registerUser(app, city.id);
  const riskyCreate = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${token2}`, "idempotency-key": "order-key-risky" },
    payload: { inputType: "text", text: "Куплю оружие без документов, срочно" },
  });
  assert.equal(riskyCreate.statusCode, 201, riskyCreate.body);
  const riskyOrderId = riskyCreate.json().orderId;

  const [riskyJob] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(riskyJob);
  const riskyResult = await handleOrderExtraction(riskyJob as never);
  await boss.complete(riskyJob.id);
  assert.equal(riskyResult.moderationDecision, "reject");
  assert.equal(riskyResult.status, "moderation_hold");
  console.log("   ok,", riskyResult);

  console.log("14. Публикация заказа в moderation_hold — 409");
  const blockedPublish = await app.inject({
    method: "POST",
    url: `/orders/${riskyOrderId}/publish`,
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(blockedPublish.statusCode, 409);
  console.log("   ok");

  console.log("15. Но автор всё ещё может отменить застрявший в moderation_hold заказ (Фаза 3 фикс state machine)");
  const cancelHeld = await app.inject({
    method: "POST",
    url: `/orders/${riskyOrderId}/cancel`,
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(cancelHeld.statusCode, 204, cancelHeld.body);
  console.log("   ok");

  console.log("16. moderation_cases записан для обоих заказов");
  const moderationCases = await db.query.moderationCases.findMany();
  assert.ok(moderationCases.some((m) => m.orderId === orderId && m.decision === "allow"));
  assert.ok(moderationCases.some((m) => m.orderId === riskyOrderId && m.decision === "reject"));
  console.log("   ok,", moderationCases.length, "записей");

  console.log("17. Чужой заказ по ID — 404 (не 403, чтобы не подтверждать существование)");
  const foreignGet = await app.inject({
    method: "GET",
    url: `/orders/${orderId}`,
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(foreignGet.statusCode, 404);
  console.log("   ok");

  console.log("18. Голосовой заказ: POST /media (audio) -> POST /orders (voice) -> worker STT заполняет sourceText");
  const { accessToken: token3 } = await registerUser(app, city.id);
  const boundary = "----verifyPhase3VoiceBoundary";
  const audioBytes = Buffer.from("fake m4a bytes for order voice verification");
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\naudio\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="order.m4a"\r\nContent-Type: audio/m4a\r\n\r\n`,
    ),
    audioBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await app.inject({
    method: "POST",
    url: "/media",
    headers: { authorization: `Bearer ${token3}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody,
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const voiceMediaId = upload.json().mediaId;

  const voiceOrder = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${token3}`, "idempotency-key": "order-voice-1" },
    payload: { inputType: "voice", audioMediaId: voiceMediaId, mediaIds: [] },
  });
  assert.equal(voiceOrder.statusCode, 201, voiceOrder.body);
  const voiceOrderId = voiceOrder.json().orderId;

  const orderRowBefore = await db.query.orders.findFirst({ where: eq(schema.orders.id, voiceOrderId) });
  assert.equal(orderRowBefore?.sourceText, null, "sourceText должен быть пуст до STT");

  const [voiceJob] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(voiceJob, "voice order job не найден в очереди");
  await handleOrderExtraction(voiceJob as never);
  await boss.complete(voiceJob.id);

  const orderRowAfter = await db.query.orders.findFirst({ where: eq(schema.orders.id, voiceOrderId) });
  assert.ok(orderRowAfter?.sourceText, "STT не заполнил sourceText голосового заказа");
  console.log("   ok, sourceText =", orderRowAfter.sourceText);

  await app.close();
  console.log(
    "\n✅ Фаза 3 проверена сквозным сценарием: orders (idempotency) → queue → worker (extraction, ontology mapping, risk, moderation rules+regulated, embedding) → publish (blocked until allow) → cancel (включая moderation_hold) → чужой заказ скрыт.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
