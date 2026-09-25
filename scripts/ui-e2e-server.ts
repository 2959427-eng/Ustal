/* eslint-disable no-console */
/**
 * ЛОКАЛЬНЫЙ тестовый сервер для UI E2E (API + worker в одном процессе).
 * Только для проверки мобильного UI против тестовой БД. Не для production.
 *
 * Почему отдельный скрипт: при AI_PROVIDER=mock нормализатор matching намеренно возвращает
 * facts:[] (см. packages/ai/src/providers/mock.ts), поэтому лента всегда пуста. Здесь тот же
 * детерминированный фикстурный нормализатор, что в backend/mobile E2E — код приложения не меняется,
 * matching policy не трогается. Распознаёт только «сборка мебели/шкафа» (навык) и «дрель» (ресурс).
 *
 *   npx tsx scripts/ui-e2e-server.ts
 */
import { mockProviders } from "../packages/ai/src/index.js";
import { loadEnv } from "../packages/config/src/index.js";
import { getBoss, JOB_TYPES } from "../packages/queue/src/index.js";
import { buildApp } from "../apps/api/src/app.js";
import { handleProfileTranscribe } from "../apps/worker/src/handlers/profile-transcribe.js";
import { handleProfileExtraction } from "../apps/worker/src/handlers/profile-extraction.js";
import { handleOrderTranscribe } from "../apps/worker/src/handlers/order-transcribe.js";
import { handleOrderExtraction } from "../apps/worker/src/handlers/order-extraction.js";
import { handleMatchingRun } from "../apps/worker/src/handlers/matching-run.js";
import { handleNotificationDispatch } from "../apps/worker/src/handlers/notification-dispatch.js";
import { dispatchRematches } from "../apps/worker/src/rematch.js";

const common = {
  constraintType: "none", constraintScope: "fact",
  resourceCapacity: { value: null, unit: null, kind: null },
  confidence: 0.95, startHour: null, endHour: null, daysOfWeek: null,
} as const;

(mockProviders.extraction as any).normalizeMatching = async (input: { text: string }) => {
  const t = input.text;
  const facts: unknown[] = [];
  const cap = t.match(/собира[а-я]*\s+(?:мебел[а-я]*|шкаф[а-я]*)|собрат[ьь]\s+(?:мебел[а-я]*|шкаф[а-я]*|кроват[а-я]*|стол[а-я]*|стеллаж[а-я]*)|сборк[а-я]*\s+мебел[а-я]*/i);
  if (cap) facts.push({ ...common, kind: "capability", resourceRole: "none", phrase: "сборка мебели", evidence: cap[0], canonicalKeys: ["assembly"], mandatory: true });
  const res = t.match(/дрел[а-я]*/i);
  if (res) facts.push({ ...common, kind: "resource", resourceRole: "available", phrase: "дрель", evidence: res[0], canonicalKeys: ["drill"], mandatory: false });
  return { data: { facts }, provider: "mock", model: "ui-e2e-fixture", tokensInput: 0, tokensOutput: 0, latencyMs: 1 };
};

async function main() {
  const env = loadEnv();
  if (env.AI_PROVIDER !== "mock" || env.NODE_ENV === "production") {
    throw new Error("ui-e2e-server: только AI_PROVIDER=mock и NODE_ENV!=production");
  }
  const host = new URL(env.DATABASE_URL.replace(/^postgres:/, "http:")).hostname;
  if (!["localhost", "127.0.0.1", "db"].includes(host)) throw new Error(`ui-e2e-server: DATABASE_URL должен быть локальным, получено host=${host}`);

  const boss = await getBoss();
  await boss.work(JOB_TYPES.PROFILE_TRANSCRIBE, handleProfileTranscribe);
  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, handleProfileExtraction);
  await boss.work(JOB_TYPES.ORDER_TRANSCRIBE, handleOrderTranscribe);
  await boss.work(JOB_TYPES.ORDER_EXTRACTION, handleOrderExtraction);
  await boss.work(JOB_TYPES.MATCHING_RUN, handleMatchingRun);
  await boss.work(JOB_TYPES.NOTIFICATION_DISPATCH, handleNotificationDispatch);
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await dispatchRematches(); } catch { console.error("rematch dispatch failed"); } finally { busy = false; }
  }, 10000);

  const app = await buildApp();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  console.log(`UI-E2E сервер: API http://0.0.0.0:${env.API_PORT} + worker (mock AI, fixture normalizer). DB host=${host}`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
