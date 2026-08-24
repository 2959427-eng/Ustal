/* eslint-disable no-console */
/**
 * Сквозная ручная проверка Фазы 4 (Matching) — тот же принцип, что и Фазы 1-3.
 *   npx tsx scripts/verify-phase4.ts
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../apps/api/src/app.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { handleProfileExtraction } from "../apps/worker/src/handlers/profile-extraction.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { handleMatchingRun } from "../apps/worker/src/handlers/matching-run.js";
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

async function submitProfile(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  text: string,
  idemKey: string,
) {
  const res = await app.inject({
    method: "POST",
    url: "/profile/inputs",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": idemKey },
    payload: { inputType: "text", text },
  });
  assert.equal(res.statusCode, 202, res.body);
  const boss = await getBoss();
  const [job] = (await boss.fetch(JOB_TYPES.PROFILE_EXTRACTION, 1)) ?? [];
  assert.ok(job, "profile_extraction job not found");
  await handleProfileExtraction(job as never);
  await boss.complete(job.id);
}

async function main() {
  const app = await buildApp();
  await app.ready();
  const db = getDb();
  const boss = await getBoss();
  await boss.clearStorage();

  // Отдельные города для этого прогона, а не переиспользование seed-городов:
  // matching-run.ts делает city-scoped SQL по ВСЕМ активным пользователям
  // города (так и должно быть в проде), поэтому повторные запуски этого
  // скрипта против одной и той же БД (без truncate между прогонами)
  // накапливали кандидатов из предыдущих прогонов в seed-городах и портили
  // проверку "ровно 1 кандидат". Уникальные города на каждый прогон изолируют
  // тест от накопленных данных, не трогая ничего в БД.
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [cityA, cityB] = await db
    .insert(schema.cities)
    .values([
      { name: `Тестгород A ${runId}`, regionName: "Тестрегион", federalDistrict: "Тестокруг", timezone: "Europe/Moscow" },
      { name: `Тестгород B ${runId}`, regionName: "Тестрегион", federalDistrict: "Тестокруг", timezone: "Europe/Moscow" },
    ])
    .returning();
  assert.ok(cityA && cityB);

  console.log("1. Настройка: автор + 4 кандидата (A: подходит, B: без профиля, C: другой город, D: заблокирован)");
  const author = await register(app, cityA.id, "Автор Заказа");
  const candA = await register(app, cityA.id, "Кандидат A");
  const candB = await register(app, cityA.id, "Кандидат B (без профиля)");
  const candC = await register(app, cityB.id, "Кандидат C (другой город)");
  const candD = await register(app, cityA.id, "Кандидат D (заблокирован)");

  await submitProfile(app, candA.accessToken, "Делаю физическую работу, переношу вещи", "profA-1");
  // candB: профиль намеренно не заполняем.
  await submitProfile(app, candC.accessToken, "Делаю физическую работу", "profC-1");
  await submitProfile(app, candD.accessToken, "Делаю физическую работу", "profD-1");
  console.log("   ok");

  console.log("2. Автор блокирует кандидата D (напрямую в БД — POST /blocks появится в Фазе 8)");
  await db.insert(schema.blocks).values({ blockerId: author.userId, blockedId: candD.userId });
  console.log("   ok");

  console.log("3. Заказ (текст без keyword-триггеров -> mock требует 'физическая работа') -> создание -> extraction -> публикация");
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${author.accessToken}`, "idempotency-key": "match-order-1" },
    payload: { inputType: "text", text: "Нужна помощь с переноской коробок в квартире на третьем этаже" },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { orderId } = create.json();

  const [extractionJob] = (await boss.fetch(JOB_TYPES.ORDER_EXTRACTION, 1)) ?? [];
  assert.ok(extractionJob);
  const extractionResult = await handleOrderExtraction(extractionJob as never);
  await boss.complete(extractionJob.id);
  assert.equal(extractionResult.moderationDecision, "allow");
  console.log("   ok, extraction:", extractionResult);

  const requirementsRow = await db.query.orderRequirements.findMany({ where: eq(schema.orderRequirements.orderId, orderId) });
  assert.ok(requirementsRow.length >= 1, "order_requirements пуст — mock keyword-heuristic не сработала");
  console.log("   order_requirements:", requirementsRow.map((r) => r.requirementType));

  const publish = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/publish`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(publish.statusCode, 200, publish.body);
  console.log("   ok, published");

  console.log("4. Забираем matching_run job (поставлен автоматически publish'ем) и выполняем");
  const [matchingJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
  assert.ok(matchingJob, "matching_run job не поставлен при публикации");
  const matchResult = await handleMatchingRun(matchingJob as never);
  await boss.complete(matchingJob.id);
  console.log("   ok,", matchResult);

  console.log("5. Только кандидат A должен попасть в matching_candidates (B без профиля, C другой город, D заблокирован)");
  assert.equal(matchResult.candidatesCount, 1, `ожидался 1 кандидат, получено ${matchResult.candidatesCount}`);
  const candidateRows = await db.query.matchingCandidates.findMany({
    where: eq(schema.matchingCandidates.matchingRunId, matchResult.matchingRunId as string),
  });
  assert.equal(candidateRows.length, 1);
  assert.equal(candidateRows[0]?.userId, candA.userId);
  assert.ok(Number(candidateRows[0]?.score) >= 10);
  assert.ok(["exact", "probable", "new_opportunity"].includes(candidateRows[0]?.matchType ?? ""));
  console.log("   ok, matchType =", candidateRows[0]?.matchType, "score =", candidateRows[0]?.score, "explanation =", candidateRows[0]?.explanation);

  console.log("6. GET /feed для кандидата A — заказ виден");
  const feedA = await app.inject({ method: "GET", url: "/feed", headers: { authorization: `Bearer ${candA.accessToken}` } });
  assert.equal(feedA.statusCode, 200);
  const feedABody = feedA.json();
  assert.ok(feedABody.items.some((i: { orderId: string }) => i.orderId === orderId), "заказ не найден в ленте кандидата A");
  console.log("   ok,", feedABody.items.length, "заказ(ов) в ленте");

  console.log("7. GET /feed для B/C/D — заказ НЕ виден ни у кого из них");
  for (const [label, cand] of [
    ["B (без профиля)", candB],
    ["C (другой город)", candC],
    ["D (заблокирован)", candD],
  ] as const) {
    const feed = await app.inject({ method: "GET", url: "/feed", headers: { authorization: `Bearer ${cand.accessToken}` } });
    assert.equal(feed.statusCode, 200);
    const body = feed.json();
    assert.ok(!body.items.some((i: { orderId: string }) => i.orderId === orderId), `заказ неожиданно виден кандидату ${label}`);
  }
  console.log("   ok");

  console.log("8. GET /feed для автора — свой заказ не должен быть в чужой ленте кандидата (у автора вообще нет входа в matching_candidates)");
  const feedAuthor = await app.inject({ method: "GET", url: "/feed", headers: { authorization: `Bearer ${author.accessToken}` } });
  assert.equal(feedAuthor.statusCode, 200);
  assert.equal(feedAuthor.json().items.length, 0);
  console.log("   ok");

  console.log("9. Отменённый заказ пропадает из ленты кандидата A");
  const cancel = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/cancel`,
    headers: { authorization: `Bearer ${author.accessToken}` },
  });
  assert.equal(cancel.statusCode, 204, cancel.body);
  const feedAfterCancel = await app.inject({ method: "GET", url: "/feed", headers: { authorization: `Bearer ${candA.accessToken}` } });
  assert.ok(!feedAfterCancel.json().items.some((i: { orderId: string }) => i.orderId === orderId));
  console.log("   ok");

  console.log("10. Регулируемый заказ (напрямую в БД, т.к. через модерацию он не может дойти до published) -> matching даёт 0 кандидатов");
  const [regulatedOrder] = await db
    .insert(schema.orders)
    .values({
      authorId: author.userId,
      cityId: cityA.id,
      sourceText: "работа с электричеством, требуется срочно",
      normalizedTitle: "Электрика",
      normalizedDescription: "работа с электричеством",
      status: "published",
      riskLevel: 2,
      moderationStatus: "manual_review", // сохранено для полноты картины, matching не смотрит на это поле
      publishedAt: new Date(),
    })
    .returning();
  assert.ok(regulatedOrder);
  await db.insert(schema.orderAiExtractions).values({
    orderId: regulatedOrder.id,
    extractionVersion: "v1",
    rawResult: { regulated: true },
  });
  await boss.send(JOB_TYPES.MATCHING_RUN, { orderId: regulatedOrder.id });
  const [regulatedJob] = (await boss.fetch(JOB_TYPES.MATCHING_RUN, 1)) ?? [];
  assert.ok(regulatedJob);
  const regulatedResult = await handleMatchingRun(regulatedJob as never);
  await boss.complete(regulatedJob.id);
  assert.equal(regulatedResult.candidatesCount, 0);
  assert.equal((regulatedResult as { regulated?: boolean }).regulated, true);
  console.log("   ok,", regulatedResult);

  await app.close();
  console.log(
    "\n✅ Фаза 4 проверена сквозным сценарием: publish -> авто-triggered matching_run -> жёсткие фильтры (город/без профиля/блокировка) -> scoring -> classification -> объяснение -> лента кандидата -> лента пуста для отсеянных и для автора -> отмена убирает из ленты -> regulated даёт 0 кандидатов.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
