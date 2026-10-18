/**
 * QA 2026-10-14, дефект №2: повторы, восстановление застрявших сообщений профиля, порядок сообщений
 * одного пользователя. Настоящие PostgreSQL, pg-boss и worker-обработчики; AI — детерминированный mock.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PgBoss from "pg-boss";
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR, schema } from "@ustal/database";
import { getBoss, JOB_TYPES, profileJobKey } from "@ustal/queue";
import { handleProfileExtraction, runProfileExtractionJob } from "./handlers/profile-extraction.js";
import { handleProfileTranscribe } from "./handlers/profile-transcribe.js";
import { dispatchStalledProfileInputs, earlierPendingInputs, loadPendingProfileInputs, MAX_FAILED_ATTEMPTS,
  profileInputRecoveryStatus, resetProfileInputRecovery, type EnqueueProfileJob } from "./profile-input-recovery.js";

assertLocalTestDatabase();
const db = getDb();
const users: string[] = [], cities: string[] = [];
const keysUsed: string[] = [];
const wrap = (data: unknown) => ({ data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 }) as never;
const res = (text: string) => ({ kind: "resource", subjectType: "physical_resource", resourceRole: "available", canonicalKeys: [],
  confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, phrase: text.replace(/^Есть /, ""), evidence: text });
/** Тексты, на которых «AI» падает: постоянно (failing) или заданное число раз (failTimes). */
const failing = new Set<string>();
const failTimes = new Map<string, number>();
const slow = new Set<string>();
let aiCalls: string[] = [];

beforeAll(async () => {
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => {
    aiCalls.push(i.text);
    if (slow.has(i.text)) await new Promise((r) => setTimeout(r, 300));
    const left = failTimes.get(i.text) ?? 0;
    if (left > 0) failTimes.set(i.text, left - 1);
    if (failing.has(i.text) || left > 0) throw Object.assign(new Error("AI timeout"), { name: "APIConnectionTimeoutError" });
    return wrap({ summary: i.text, capabilities: [], resources: [] });
  });
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (i) =>
    wrap({ facts: i.text.split(/\n[^\n]*:\n/).map((t) => res(t.trim())) }));
});
afterAll(async () => {
  if (keysUsed.length) await db.execute(sql`delete from pgboss.job where singletonkey in (${sql.join(keysUsed.map((k) => sql`${k}`), sql`, `)})`);
  await db.execute(sql`delete from pgboss.job where name like 'qa_recovery_%'`);
  if (users.length) {
    await db.delete(schema.capabilityProfiles).where(inArray(schema.capabilityProfiles.userId, users));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  }
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await (await getBoss()).stop({ graceful: false });
  await getSql().end();
});

async function newUser() {
  const [city] = await db.insert(schema.cities).values({ name: "QA_REC_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
  users.push(u!.id); cities.push(city!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  return u!.id;
}
/** Сообщение, сохранённое API `ageSeconds` секунд назад (задача в очередь при этом не ставится). */
async function input(userId: string, text: string, ageSeconds = 120, status = "confirmed") {
  const [row] = await db.insert(schema.profileSourceInputs).values({ userId, inputType: status === "confirmed" ? "text" : "voice", rawText: text, status }).returning();
  await db.execute(sql`update profile_source_inputs set created_at = now() - make_interval(secs => ${ageSeconds}) where id = ${row!.id}`);
  keysUsed.push(profileJobKey("profile-extraction", row!.id), profileJobKey("profile-transcribe", row!.id));
  return row!.id;
}
const job = (userId: string, sourceInputId: string) => ({ id: randomUUID(), data: { userId, sourceInputId } }) as never;
const liveProfiles = (sourceInputId: string) => db.select().from(schema.capabilityProfiles)
  .where(and(eq(schema.capabilityProfiles.sourceInputId, sourceInputId), ne(schema.capabilityProfiles.status, "invalidated")));
async function sourceText(profileId: string) {
  const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId) });
  return doc!.sourceText.split(PROFILE_SOURCE_SEPARATOR);
}
type Queued = Parameters<EnqueueProfileJob>[0];
const recorder = () => { const got: Queued[] = []; return { got, enqueue: async (p: Queued) => { got.push(p); } }; };
const recovery = async (id: string, stage = "extraction") => (await profileInputRecoveryStatus(id)).find((r) => r.stage === stage);
/** Восстановление «прямо сейчас», как если бы пауза после последней неудачи уже прошла. */
const dueNow = async (u: string) => {
  await db.update(schema.profileInputRecovery).set({ lastFailedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.profileInputRecovery.userId, u));
  const { got, enqueue } = recorder();
  await dispatchStalledProfileInputs(enqueue, { userId: u });
  return got.map((p) => p.id);
};
/** Строка истории задачи pg-boss с заданным состоянием (как её оставил бы pg-boss). */
async function jobRow(key: string, state: string, finishedSecondsAgo: number | null) {
  await db.execute(sql`insert into pgboss.job (name, data, state, singletonkey, completedon)
    values (${JOB_TYPES.PROFILE_EXTRACTION}, '{}'::jsonb, ${state}::pgboss.job_state, ${key},
      ${finishedSecondsAgo === null ? null : sql`now() - make_interval(secs => ${finishedSecondsAgo})`})`);
}
const extractionKey = (id: string) => profileJobKey("profile-extraction", id);

describe("порядок сообщений одного пользователя", () => {
  it("задача позднего сообщения сначала разбирает более раннее необработанное — порядок в профиле сохраняется", async () => {
    const u = await newUser();
    const m1 = await input(u, "Есть дрель");
    const m2 = await input(u, "Есть стремянка", 60);
    const r2 = await handleProfileExtraction(job(u, m2));
    expect(await liveProfiles(m1)).toHaveLength(1);
    expect(await sourceText(r2.profileId)).toEqual(["Есть дрель", "Есть стремянка"]);
    expect((await liveProfiles(m1))[0]!.profileVersion).toBeLessThan(r2.profileVersion);
  });

  it("настоящий pg-boss: задачи пришли в обратном порядке и выполняются параллельно — порядок всё равно 1, 2, 3", async () => {
    const u = await newUser();
    const ids = [await input(u, "Есть дрель", 300), await input(u, "Есть стремянка", 200), await input(u, "Есть перфоратор", 100)];
    const boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
    const queue = `qa_recovery_${randomUUID().slice(0, 8)}`;
    try {
      for (const id of [...ids].reverse()) await boss.send(queue, { userId: u, sourceInputId: id });
      await boss.work(queue, { teamSize: 3, teamConcurrency: 3, newJobCheckInterval: 100 }, runProfileExtractionJob as never);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (await Promise.all(ids.map(liveProfiles))).some((p) => p.length === 0))
        await new Promise((r) => setTimeout(r, 200));
    } finally { await boss.stop({ graceful: false }); }
    const profiles = await Promise.all(ids.map(liveProfiles));
    expect(profiles.map((p) => p.length)).toEqual([1, 1, 1]); // каждое сообщение — ровно одна версия
    const versions = profiles.map((p) => p[0]!.profileVersion);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(await sourceText(profiles[2]![0]!.id)).toEqual(["Есть дрель", "Есть стремянка", "Есть перфоратор"]);
  }, 40_000);

  it("сбой раннего сообщения откладывает позднее (без ошибки задачи); после восстановления оба — по порядку", async () => {
    const u = await newUser();
    const m1 = await input(u, "Есть болгарка");
    const m2 = await input(u, "Есть лестница", 90);
    failing.add("Есть болгарка");
    try {
      expect(await runProfileExtractionJob(job(u, m2))).toEqual({ deferred: true, waitingFor: m1 });
      expect(await liveProfiles(m2)).toHaveLength(0);
      // Задача позднего сообщения завершилась без ошибки: его раунды восстановления не расходуются.
      expect((await loadPendingProfileInputs({ userId: u })).map((p) => [p.id, p.failedAttempts])).toEqual([[m1, 1], [m2, 0]]);
    } finally { failing.delete("Есть болгарка"); }
    const r2 = await handleProfileExtraction(job(u, m2));
    expect(await sourceText(r2.profileId)).toEqual(["Есть болгарка", "Есть лестница"]);
  });

  it("сообщение, исчерпавшее раунды восстановления, не блокирует более поздние", async () => {
    const u = await newUser();
    const m1 = await input(u, "Есть сломанный текст");
    const m2 = await input(u, "Есть тачка", 90);
    await db.insert(schema.profileInputRecovery).values({ sourceInputId: m1, stage: "extraction", userId: u, state: "exhausted", failedAttempts: MAX_FAILED_ATTEMPTS });
    expect(await earlierPendingInputs(u, m2)).toEqual([]);
    const r2 = await handleProfileExtraction(job(u, m2));
    expect(await sourceText(r2.profileId)).toEqual(["Есть тачка"]);
    expect(await liveProfiles(m1)).toHaveLength(0);
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got).toEqual([]);
  });

  it("отозванное и неподтверждённое раннее сообщение не задерживает и не попадает в профиль", async () => {
    const u = await newUser();
    const revoked = await input(u, "Есть отозванное", 300);
    await db.update(schema.profileSourceInputs).set({ revokedAt: new Date() }).where(eq(schema.profileSourceInputs.id, revoked));
    await input(u, "Есть голосовое", 200, "awaiting_review");
    const m = await input(u, "Есть шуруповёрт", 100);
    const r = await handleProfileExtraction(job(u, m));
    expect(await sourceText(r.profileId)).toEqual(["Есть шуруповёрт"]);
  });
});

describe("уже обработанное сообщение не применяется повторно", () => {
  it("повторная доставка (сбой после сохранения, перезапуск worker, восстановление) возвращает ту же версию", async () => {
    const u = await newUser();
    const m = await input(u, "Есть генератор");
    const first = await handleProfileExtraction(job(u, m));
    for (let i = 0; i < 3; i++) expect(await runProfileExtractionJob(job(u, m))).toEqual(first);
    await db.update(schema.capabilityProfiles).set({ status: "applied" }).where(eq(schema.capabilityProfiles.id, first.profileId));
    expect(await handleProfileExtraction(job(u, m))).toEqual(first);
    expect(await db.select().from(schema.capabilityProfiles).where(eq(schema.capabilityProfiles.userId, u))).toHaveLength(1);
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got).toEqual([]);
  });

  it("повторная доставка расшифровки не перезапускает STT и не затирает подтверждённый текст", async () => {
    const u = await newUser();
    const m = await input(u, "x", 120, "awaiting_review");
    const stt = vi.spyOn(mockProviders.stt, "transcribe");
    const calls = stt.mock.calls.length;
    expect(await handleProfileTranscribe({ id: randomUUID(), data: { sourceInputId: m } } as never)).toMatchObject({ skipped: true });
    expect(stt.mock.calls.length).toBe(calls);
  });
});

describe("восстановление застрявших сообщений", () => {
  it("API не поставил задачу (сбой очереди / рестарт): сообщение находится и ставится ровно один раз, даже двумя worker сразу", async () => {
    const u = await newUser();
    const m = await input(u, "Есть бетономешалка");
    const fresh = await input(u, "Есть свежее", 5); // обычный путь ещё не опоздал — не трогаем
    const twice = await Promise.all([dispatchStalledProfileInputs(undefined, { userId: u }), dispatchStalledProfileInputs(undefined, { userId: u })]);
    expect(twice.flat().filter((id) => id === fresh)).toEqual([]);
    const rows = (await db.execute(sql`select state::text from pgboss.job where singletonkey = ${extractionKey(m)}`)) as unknown as Array<{ state: string }>;
    expect(rows.map((r) => r.state)).toEqual(["created"]);
    expect((await db.execute(sql`select data, retrylimit from pgboss.job where singletonkey = ${extractionKey(m)}`) as unknown as Array<{ data: unknown; retrylimit: number }>)[0])
      .toEqual({ data: { userId: u, sourceInputId: m }, retrylimit: 4 });
    // Живая задача (в очереди / выполняется / ждёт повтора) — восстановление её не дублирует.
    expect(await dispatchStalledProfileInputs(undefined, { userId: u })).toEqual([]);
  });

  it("задача выполняется на упавшем worker (active) — не дублируется; повторит сам pg-boss по истечении", async () => {
    const u = await newUser();
    const m = await input(u, "Есть каток");
    await jobRow(extractionKey(m), "active", null);
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got).toEqual([]);
  });

  it("отложенная задача (завершилась, сообщение не обработано) снова ставится через минуту", async () => {
    const u = await newUser();
    const m = await input(u, "Есть плиткорез");
    await jobRow(extractionKey(m), "completed", 10);
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got).toEqual([]);
    await db.execute(sql`update pgboss.job set completedon = now() - interval '61 seconds' where singletonkey = ${extractionKey(m)}`);
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got.map((p) => p.id)).toEqual([m]);
  });

  it("не восстанавливаются: обработанные, отозванные, ждущие подтверждения расшифровки, старше 48 часов; расшифровка — своей задачей", async () => {
    const u = await newUser();
    const done = await input(u, "Есть уровень", 600);
    await handleProfileExtraction(job(u, done));
    const revoked = await input(u, "Есть отзыв", 500);
    await db.update(schema.profileSourceInputs).set({ revokedAt: new Date() }).where(eq(schema.profileSourceInputs.id, revoked));
    await input(u, "x", 400, "awaiting_review");
    await input(u, "Есть старьё", 49 * 3600);
    const voice = await input(u, "x", 300, "transcribing");
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got.map((p) => [p.id, p.status])).toEqual([[voice, "transcribing"]]);
  });

  it("стресс: 30 пользователей × 3 сообщения, задачи потеряны; восстановление тремя worker + pg-boss — всё разобрано по порядку, без дублей", async () => {
    const us = await Promise.all(Array.from({ length: 30 }, () => newUser()));
    const byUser = new Map<string, string[]>();
    for (const u of us) byUser.set(u, [await input(u, "Есть молоток", 300), await input(u, "Есть пила", 200), await input(u, "Есть рубанок", 100)]);
    const queue = `qa_recovery_${randomUUID().slice(0, 8)}`;
    const enqueue = (boss: PgBoss) => async (p: Queued) =>
      boss.send(queue, { userId: p.userId, sourceInputId: p.id }, { singletonKey: extractionKey(p.id), retryLimit: 4, retryDelay: 1 });
    const workers = await Promise.all([1, 2, 3].map(async () => { const b = new PgBoss(process.env.DATABASE_URL!); await b.start(); return b; }));
    try {
      // Три worker одновременно (как после перезапуска нескольких экземпляров) — без дублей задач.
      await Promise.all(workers.flatMap((b) => us.map((u) => dispatchStalledProfileInputs(enqueue(b), { userId: u }))));
      const jobs = (await db.execute(sql`select singletonkey from pgboss.job where name = ${queue}`)) as unknown as Array<{ singletonkey: string }>;
      expect(jobs.length).toBe(90);
      expect(new Set(jobs.map((j) => j.singletonkey)).size).toBe(90);
      for (const b of workers) await b.work(queue, { teamSize: 4, teamConcurrency: 4, newJobCheckInterval: 100 }, runProfileExtractionJob as never);
      const all = [...byUser.values()].flat();
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && (await db.select({ id: schema.capabilityProfiles.sourceInputId }).from(schema.capabilityProfiles)
        .where(and(inArray(schema.capabilityProfiles.sourceInputId, all), ne(schema.capabilityProfiles.status, "invalidated")))).length < all.length)
        await new Promise((r) => setTimeout(r, 300));
    } finally { for (const b of workers) await b.stop({ graceful: false }); }
    for (const [, ids] of byUser) {
      const profiles = await Promise.all(ids.map(liveProfiles));
      expect(profiles.map((p) => p.length)).toEqual([1, 1, 1]);
      expect(await sourceText(profiles[2]![0]!.id)).toEqual(["Есть молоток", "Есть пила", "Есть рубанок"]);
    }
  }, 120_000);
});

describe("общий лимит неудач (profile_input_recovery), не зависящий от задач pg-boss", () => {
  it("1. одна-две временные ошибки: восстановление и повтор доводят до успеха", async () => {
    const u = await newUser();
    const m = await input(u, "Есть временный сбой");
    failTimes.set("Есть временный сбой", 2);
    await expect(runProfileExtractionJob(job(u, m))).rejects.toThrow("AI timeout");
    expect(await recovery(m)).toMatchObject({ state: "retrying", failedAttempts: 1, lastError: "APIConnectionTimeoutError: AI timeout" });
    expect(await dueNow(u)).toEqual([m]); // после паузы восстановление ставит снова
    await expect(runProfileExtractionJob(job(u, m))).rejects.toThrow("AI timeout");
    expect(await recovery(m)).toMatchObject({ state: "retrying", failedAttempts: 2 });
    const done = await runProfileExtractionJob(job(u, m));
    expect(done).toHaveProperty("profileId");
    expect(await liveProfiles(m)).toHaveLength(1);
  });

  it("2. постоянная ошибка: ровно MAX_FAILED_ATTEMPTS вызовов AI, затем exhausted — ни задача, ни восстановление, ни поздние сообщения AI не вызывают", async () => {
    const u = await newUser();
    const m = await input(u, "Есть вечная ошибка", 600);
    failing.add("Есть вечная ошибка");
    try {
      aiCalls = [];
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await expect(runProfileExtractionJob(job(u, m))).rejects.toThrow("AI timeout");
      expect(await recovery(m)).toMatchObject({ state: "exhausted", failedAttempts: MAX_FAILED_ATTEMPTS, attempts: MAX_FAILED_ATTEMPTS });
      expect((await recovery(m))!.exhaustedAt).not.toBeNull();
      for (let i = 0; i < 5; i++) expect(await runProfileExtractionJob(job(u, m))).toEqual({ skipped: "recovery_exhausted" });
      expect(await dueNow(u)).toEqual([]);
      const later = await input(u, "Есть болт", 60);
      const r = await handleProfileExtraction(job(u, later));
      expect(await sourceText(r.profileId)).toEqual(["Есть болт"]);
      expect(aiCalls.filter((t) => t === "Есть вечная ошибка")).toHaveLength(MAX_FAILED_ATTEMPTS);
    } finally { failing.delete("Есть вечная ошибка"); }
  });

  it("3. архивирование и удаление задач pg-boss не сбрасывают лимит", async () => {
    const u = await newUser();
    const m = await input(u, "Есть архивная ошибка", 600);
    await db.insert(schema.profileInputRecovery).values({ sourceInputId: m, stage: "extraction", userId: u, state: "exhausted",
      failedAttempts: MAX_FAILED_ATTEMPTS, attempts: MAX_FAILED_ATTEMPTS, lastFailedAt: new Date(Date.now() - 13 * 3600_000) });
    for (let i = 0; i < 3; i++) await jobRow(extractionKey(m), "failed", 13 * 3600);
    // pg-boss через 12 ч переносит неудачные задачи в архив (а затем удаляет).
    await db.execute(sql`with moved as (delete from pgboss.job where singletonkey = ${extractionKey(m)} returning *)
      insert into pgboss.archive (id, name, priority, data, state, retrylimit, retrycount, retrydelay, retrybackoff, startafter, startedon,
        singletonkey, singletonon, expirein, createdon, completedon, keepuntil, on_complete, output)
      select id, name, priority, data, state, retrylimit, retrycount, retrydelay, retrybackoff, startafter, startedon,
        singletonkey, singletonon, expirein, createdon, completedon, keepuntil, on_complete, output from moved`);
    expect(await dueNow(u)).toEqual([]);
    await db.execute(sql`delete from pgboss.archive where singletonkey = ${extractionKey(m)}`);
    expect(await dueNow(u)).toEqual([]);
    aiCalls = [];
    expect(await runProfileExtractionJob(job(u, m))).toEqual({ skipped: "recovery_exhausted" });
    expect(aiCalls).toEqual([]);
  });

  it("4. перезапуск worker: счётчик в БД; попытка, прерванная остановкой worker, засчитывается неудачей", async () => {
    const u = await newUser();
    const m = await input(u, "Есть прерванная попытка", 600);
    // Состояние, оставленное прежним процессом: 9 неудач и незавершённая попытка (аренда истекла).
    await db.insert(schema.profileInputRecovery).values({ sourceInputId: m, stage: "extraction", userId: u, state: "processing",
      failedAttempts: MAX_FAILED_ATTEMPTS - 1, attempts: MAX_FAILED_ATTEMPTS - 1, leaseOwner: "worker-before-restart", leaseUntil: new Date(Date.now() - 1000) });
    // Новый процесс: свой экземпляр pg-boss, ничего в памяти.
    const boss = new PgBoss(process.env.DATABASE_URL!); await boss.start(); await boss.stop({ graceful: false });
    aiCalls = [];
    expect(await runProfileExtractionJob(job(u, m))).toEqual({ skipped: "recovery_exhausted" });
    expect(aiCalls).toEqual([]);
    expect(await recovery(m)).toMatchObject({ state: "exhausted", failedAttempts: MAX_FAILED_ATTEMPTS, leaseUntil: null });
    expect((await recovery(m))!.lastError).toMatch(/^lease_expired/);
    // Действующая аренда (попытка идёт на другом worker) восстановлением не дублируется.
    const m2 = await input(u, "Есть идущая попытка", 600);
    await db.insert(schema.profileInputRecovery).values({ sourceInputId: m2, stage: "extraction", userId: u, state: "processing",
      leaseOwner: "other-worker", leaseUntil: new Date(Date.now() + 300_000) });
    const { got, enqueue } = recorder();
    await dispatchStalledProfileInputs(enqueue, { userId: u });
    expect(got).toEqual([]);
  });

  it("5. два worker одновременно с одним сообщением: неудача засчитывается один раз", async () => {
    const u = await newUser();
    const m = await input(u, "Есть двойная ошибка");
    failing.add("Есть двойная ошибка"); slow.add("Есть двойная ошибка");
    try {
      const results = await Promise.allSettled([1, 2, 3].map(() => runProfileExtractionJob(job(u, m))));
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(await recovery(m)).toMatchObject({ state: "retrying", failedAttempts: 1, attempts: 1, leaseUntil: null });
      // Два worker запускают восстановление одновременно — одна задача (ключ одиночности), счётчик не меняется.
      await db.update(schema.profileInputRecovery).set({ lastFailedAt: new Date(Date.now() - 3600_000) }).where(eq(schema.profileInputRecovery.sourceInputId, m));
      await Promise.all([dispatchStalledProfileInputs(undefined, { userId: u }), dispatchStalledProfileInputs(undefined, { userId: u })]);
      const rows = (await db.execute(sql`select 1 from pgboss.job where singletonkey = ${extractionKey(m)}`)) as unknown as unknown[];
      expect(rows).toHaveLength(1);
      expect(await recovery(m)).toMatchObject({ failedAttempts: 1 });
    } finally { failing.delete("Есть двойная ошибка"); slow.delete("Есть двойная ошибка"); }
  });

  it("6. успешная обработка завершает recovery state; ручной повтор возвращает исчерпанное сообщение в обработку", async () => {
    const u = await newUser();
    const m = await input(u, "Есть ручной повтор", 3 * 24 * 3600); // старше окна автоматического восстановления
    await db.insert(schema.profileInputRecovery).values({ sourceInputId: m, stage: "extraction", userId: u, state: "exhausted",
      failedAttempts: MAX_FAILED_ATTEMPTS, attempts: MAX_FAILED_ATTEMPTS, lastError: "APIConnectionTimeoutError: AI timeout" });
    const { got, enqueue } = recorder();
    expect(await resetProfileInputRecovery(m, enqueue)).toEqual({ ok: true, stage: "extraction" });
    expect(got.map((p) => p.id)).toEqual([m]);
    expect(await recovery(m)).toMatchObject({ state: "retrying", failedAttempts: 0, manualResets: 1 });
    const r = await runProfileExtractionJob(job(u, m));
    expect(r).toHaveProperty("profileId");
    expect(await recovery(m)).toMatchObject({ state: "succeeded", failedAttempts: 0, leaseUntil: null, leaseOwner: null,
      attempts: MAX_FAILED_ATTEMPTS + 1, lastError: "APIConnectionTimeoutError: AI timeout" });
    expect((await recovery(m))!.succeededAt).not.toBeNull();
    expect(await resetProfileInputRecovery(m, enqueue)).toEqual({ ok: false, reason: "already_processed" });
  });

  it("расшифровка: свой счётчик; после лимита STT не вызывается", async () => {
    const u = await newUser();
    const m = await input(u, "x", 600, "transcribing");
    await db.update(schema.profileSourceInputs).set({ audioMediaId: randomUUID() }).where(eq(schema.profileSourceInputs.id, m));
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
      await expect(handleProfileTranscribe({ id: randomUUID(), data: { sourceInputId: m } } as never)).rejects.toThrow("not found");
    expect(await recovery(m, "transcribe")).toMatchObject({ state: "exhausted", failedAttempts: MAX_FAILED_ATTEMPTS });
    expect(await handleProfileTranscribe({ id: randomUUID(), data: { sourceInputId: m } } as never)).toMatchObject({ skipped: "recovery_exhausted" });
    expect(await dueNow(u)).toEqual([]);
  });
});
