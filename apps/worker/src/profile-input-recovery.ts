import { AiConsentDenied } from "@ustal/ai";
import { workerConsentEnforced } from "./worker-consent.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import {
  getBoss,
  JOB_TYPES,
  PROFILE_INPUT_RECOVERY_WINDOW_HOURS,
  profileExtractionJobOptions,
  profileJobKey,
  profileTranscribeJobOptions,
} from "@ustal/queue";

/**
 * Восстановление необработанных сообщений профиля, порядок их обработки и общий лимит неудач
 * (QA 2026-10-14, дефект №2).
 *
 * Сообщение профиля считается необработанным, пока оно не отозвано и
 *  - либо ждёт расшифровки (status = 'transcribing'),
 *  - либо подтверждено (status = 'confirmed'), но по нему нет версии профиля, кроме invalidated.
 *
 * Лимит неудач хранится в таблице profile_input_recovery (одна строка на сообщение и этап), а не в истории
 * задач pg-boss: архивирование задач, перезапуск worker и новая задача счётчик не сбрасывают. Каждая
 * попытка обработки — аренда строки (lease_until): одновременно сообщение обрабатывает один учтённый
 * исполнитель, неудача засчитывается ровно один раз, а аренда, истёкшая без результата (worker
 * остановился посреди попытки), тоже засчитывается как неудача. После MAX_FAILED_ATTEMPTS неудач
 * состояние exhausted: сообщение больше не ставится в AI автоматически — ни восстановлением, ни
 * повторами pg-boss, ни задачами более поздних сообщений. Вернуть его в обработку можно только явно:
 * resetProfileInputRecovery (CLI retry-profile-input-cli.ts). Успешная обработка переводит состояние в
 * succeeded и обнуляет счётчик неудач (общее число попыток и последняя ошибка остаются для диагностики).
 *
 * Восстановление (тик worker): сообщения от RECOVERY_GRACE_SECONDS до RECOVERY_WINDOW_HOURS, не exhausted,
 * без живой задачи в pg-boss и без действующей аренды; после неудачи — пауза 2^n минут (не больше часа).
 */
export const RECOVERY_WINDOW_HOURS = PROFILE_INPUT_RECOVERY_WINDOW_HOURS;
/** Обычный путь (API ставит задачу сразу) получает это время, прежде чем вмешается восстановление. */
export const RECOVERY_GRACE_SECONDS = 60;
/** Общий лимит неудачных попыток на сообщение и этап (одна задача pg-boss — до 5 попыток). */
export const MAX_FAILED_ATTEMPTS = 10;
/** Аренда попытки: дольше любой нормальной обработки; истечение = worker остановился посреди попытки. */
export const ATTEMPT_LEASE_SECONDS = 600;

export type RecoveryStage = "transcribe" | "extraction";
export type RecoveryState = "processing" | "retrying" | "exhausted" | "succeeded";

export class ProfileInputExhausted extends Error {
  constructor(readonly sourceInputId: string, readonly stage: RecoveryStage) {
    super(`Profile input ${sourceInputId} (${stage}) reached the failure limit; automatic processing stopped`);
  }
}

export interface PendingProfileInput {
  id: string;
  userId: string;
  status: "confirmed" | "transcribing";
  recoveryState: RecoveryState | null;
  failedAttempts: number;
  liveJobs: number;
}

interface PendingQuery {
  userId?: string;
  /** Только сообщения раньше (before) или позже (after) данного — в порядке (created_at, id). */
  before?: string;
  after?: string;
  confirmedOnly?: boolean;
  graceSeconds?: number;
  /**
   * Фильтр — в SQL, до limit: иначе старые исчерпанные или уже поставленные сообщения занимали бы выборку.
   * notExhausted — лимит неудач не исчерпан; due — вдобавок нет живой задачи и аренды, пауза прошла.
   */
  only?: "notExhausted" | "due";
  limit?: number;
}

const EXTRACTION_KEY_PREFIX = profileJobKey("profile-extraction", "");
const TRANSCRIBE_KEY_PREFIX = profileJobKey("profile-transcribe", "");

export async function loadPendingProfileInputs(q: PendingQuery = {}): Promise<PendingProfileInput[]> {
  const db = getDb();
  const filters: SQL[] = [];
  if (q.userId) filters.push(sql`and psi.user_id = ${q.userId}`);
  if (q.before)
    filters.push(sql`and (psi.created_at, psi.id) < (select created_at, id from profile_source_inputs where id = ${q.before})`);
  if (q.after)
    filters.push(sql`and (psi.created_at, psi.id) > (select created_at, id from profile_source_inputs where id = ${q.after})`);
  if (q.only) filters.push(sql`and r.state is distinct from 'exhausted'`);
  if (q.only === "due" && workerConsentEnforced()) filters.push(sql`and not exists (select 1 from ai_consent_blocked_work b where b.source_id=psi.id and b.kind in ('profile_transcribe','profile_extract') and b.state in ('waiting','ready','leased'))`);
  if (q.only === "due")
    filters.push(sql`and coalesce(j.live, 0) = 0
      and (r.lease_until is null or r.lease_until <= now())
      and (r.last_failed_at is null
        or r.last_failed_at <= now() - make_interval(mins => least(power(2, r.failed_attempts), 60)::int))
      and (j.last is null or j.last <= now() - interval '1 minute')`);
  const statusFilter = q.confirmedOnly
    ? sql`psi.status = 'confirmed'`
    : sql`psi.status in ('confirmed', 'transcribing')`;
  // Живые задачи — из pg-boss (живые задачи не архивируются); pg-boss создаёт схему при первом запуске.
  const [queue] = (await db.execute(sql`select to_regclass('pgboss.job') is not null as present`)) as unknown as Array<{ present: boolean }>;
  const jobs = queue?.present
    ? sql`select
        count(*) filter (where state::text in ('created', 'retry', 'active'))::int as live,
        max(completedon) as last
      from pgboss.job
      where name in (${JOB_TYPES.PROFILE_EXTRACTION}, ${JOB_TYPES.PROFILE_TRANSCRIBE})
        and singletonkey = case when psi.status = 'transcribing'
          then ${TRANSCRIBE_KEY_PREFIX} || psi.id::text else ${EXTRACTION_KEY_PREFIX} || psi.id::text end`
    : sql`select null::int as live, null::timestamptz as last`;
  const rows = (await db.execute(sql`
    select psi.id, psi.user_id, psi.status, r.state as recovery_state, r.failed_attempts, j.live
    from profile_source_inputs psi
    left join profile_input_recovery r on r.source_input_id = psi.id
      and r.stage = case when psi.status = 'transcribing' then 'transcribe' else 'extraction' end
    left join lateral (${jobs}) j on true
    where psi.revoked_at is null
      and ${statusFilter}
      and psi.created_at > now() - make_interval(hours => ${RECOVERY_WINDOW_HOURS})
      and psi.created_at <= now() - make_interval(secs => ${q.graceSeconds ?? 0})
      and (psi.status = 'transcribing' or not exists (
        select 1 from capability_profiles cp where cp.source_input_id = psi.id and cp.status <> 'invalidated'))
      ${sql.join(filters, sql` `)}
    order by psi.created_at, psi.id
    limit ${q.limit ?? 50}`)) as unknown as Array<{ id: string; user_id: string; status: PendingProfileInput["status"];
      recovery_state: RecoveryState | null; failed_attempts: number | null; live: number | null }>;
  return rows.map((r) => ({ id: r.id, userId: r.user_id, status: r.status, recoveryState: r.recovery_state,
    failedAttempts: r.failed_attempts ?? 0, liveJobs: r.live ?? 0 }));
}

export const isExhausted = (p: PendingProfileInput) => p.recoveryState === "exhausted";

/** Более ранние необработанные подтверждённые сообщения пользователя, которые должны войти в профиль раньше. */
export async function earlierPendingInputs(userId: string, sourceInputId: string) {
  return loadPendingProfileInputs({ userId, before: sourceInputId, confirmedOnly: true, only: "notExhausted" });
}

type Claim = "claimed" | "busy" | "exhausted";

/** Начать учтённую попытку: аренда строки; истёкшая аренда засчитывается как неудача. */
async function claimAttempt(stage: RecoveryStage, sourceInputId: string, userId: string, owner: string): Promise<Claim> {
  return getDb().transaction(async (tx) => {
    await tx.insert(schema.profileInputRecovery).values({ sourceInputId, stage, userId, state: "retrying" }).onConflictDoNothing();
    const [r] = (await tx.execute(sql`
      select state, failed_attempts, lease_until is not null as leased, coalesce(lease_until > now(), false) as lease_live
      from profile_input_recovery where source_input_id = ${sourceInputId} and stage = ${stage} for update`)) as unknown as
      Array<{ state: RecoveryState; failed_attempts: number; leased: boolean; lease_live: boolean }>;
    if (!r || r.state === "exhausted") return "exhausted";
    if (r.lease_live) return "busy";
    const where = and(eq(schema.profileInputRecovery.sourceInputId, sourceInputId), eq(schema.profileInputRecovery.stage, stage));
    if (r.leased) {
      // Прежняя попытка не завершилась (worker остановлен, перезапущен, упал) — это тоже неудача.
      const failed = r.failed_attempts + 1;
      const exhausted = failed >= MAX_FAILED_ATTEMPTS;
      await tx.update(schema.profileInputRecovery).set({
        failedAttempts: failed, lastError: "lease_expired: обработка прервана (worker остановлен посреди попытки)",
        lastFailedAt: sql`now()`, firstFailedAt: sql`coalesce(first_failed_at, now())`,
        leaseUntil: null, leaseOwner: null, updatedAt: sql`now()`,
        ...(exhausted ? { state: "exhausted", exhaustedAt: sql`now()` } : {}),
      }).where(where);
      if (exhausted) { logExhausted(sourceInputId, stage); return "exhausted"; }
    }
    await tx.update(schema.profileInputRecovery).set({
      state: "processing", attempts: sql`attempts + 1`, leaseOwner: owner, updatedAt: sql`now()`,
      leaseUntil: sql`now() + make_interval(secs => ${ATTEMPT_LEASE_SECONDS})`,
    }).where(where);
    return "claimed";
  });
}

async function finishAttempt(stage: RecoveryStage, sourceInputId: string, owner: string, error?: unknown) {
  const where = and(eq(schema.profileInputRecovery.sourceInputId, sourceInputId), eq(schema.profileInputRecovery.stage, stage),
    eq(schema.profileInputRecovery.leaseOwner, owner));
  if (error === undefined) {
    await getDb().update(schema.profileInputRecovery).set({ state: "succeeded", succeededAt: sql`now()`, failedAttempts: 0,
      leaseUntil: null, leaseOwner: null, updatedAt: sql`now()` }).where(where);
    return;
  }
  if (error instanceof AiConsentDenied) {
    await getDb().update(schema.profileInputRecovery).set({ state: "retrying", leaseUntil: null, leaseOwner: null, updatedAt: sql`now()` }).where(where);
    return;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const [row] = await getDb().update(schema.profileInputRecovery).set({
    failedAttempts: sql`failed_attempts + 1`,
    state: sql`case when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS} then 'exhausted' else 'retrying' end`,
    exhaustedAt: sql`case when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS} then now() else exhausted_at end`,
    lastError: message.slice(0, 500), lastFailedAt: sql`now()`, firstFailedAt: sql`coalesce(first_failed_at, now())`,
    leaseUntil: null, leaseOwner: null, updatedAt: sql`now()`,
  }).where(where).returning({ state: schema.profileInputRecovery.state });
  if (row?.state === "exhausted") logExhausted(sourceInputId, stage);
}

function logExhausted(sourceInputId: string, stage: RecoveryStage) {
  console.error(JSON.stringify({ event: "profile_input_recovery_exhausted", sourceInputId, stage, maxFailedAttempts: MAX_FAILED_ATTEMPTS }));
}

/**
 * Учтённая попытка обработки сообщения. Исчерпан лимит — ProfileInputExhausted без вызова fn (AI не
 * вызывается). Если сообщение в этот момент обрабатывает другая учтённая попытка (задача позднего
 * сообщения разбирает раннее одновременно с его собственной задачей), fn выполняется без повторного
 * учёта: обработка идемпотентна, а неудача засчитывается только у владельца аренды.
 */
export async function withRecoveryTracking<T>(stage: RecoveryStage, input: { id: string; userId: string }, fn: () => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const claim = await claimAttempt(stage, input.id, input.userId, owner);
  if (claim === "exhausted") throw new ProfileInputExhausted(input.id, stage);
  if (claim === "busy") return fn();
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await finishAttempt(stage, input.id, owner, error).catch(() => undefined);
    throw error;
  }
  await finishAttempt(stage, input.id, owner);
  return result;
}

/** Диагностика: состояние автоматической обработки сообщения по этапам. */
export function profileInputRecoveryStatus(sourceInputId: string) {
  return getDb().select().from(schema.profileInputRecovery).where(eq(schema.profileInputRecovery.sourceInputId, sourceInputId));
}

export type EnqueueProfileJob = (p: Pick<PendingProfileInput, "id" | "userId" | "status">) => Promise<unknown>;
export const enqueuePendingInput: EnqueueProfileJob = async (p) => {
  const boss = await getBoss();
  return p.status === "transcribing"
    ? boss.send(JOB_TYPES.PROFILE_TRANSCRIBE, { sourceInputId: p.id }, profileTranscribeJobOptions(p.id))
    : boss.send(JOB_TYPES.PROFILE_EXTRACTION, { userId: p.userId, sourceInputId: p.id }, profileExtractionJobOptions(p.id));
};

/**
 * Явный повтор (ручной): обнуляет счётчик неудач и снимает exhausted, затем ставит задачу. Только для
 * необработанного, не отозванного сообщения; окно RECOVERY_WINDOW_HOURS здесь не действует.
 */
export async function resetProfileInputRecovery(sourceInputId: string, enqueue: EnqueueProfileJob = enqueuePendingInput) {
  const input = await getDb().query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, sourceInputId) });
  if (!input) return { ok: false as const, reason: "not_found" as const };
  if (input.revokedAt) return { ok: false as const, reason: "revoked" as const };
  if (input.status !== "confirmed" && input.status !== "transcribing") return { ok: false as const, reason: "not_ready" as const };
  const [done] = (await getDb().execute(sql`select 1 from capability_profiles
    where source_input_id = ${sourceInputId} and status <> 'invalidated' limit 1`)) as unknown as unknown[];
  if (input.status === "confirmed" && done) return { ok: false as const, reason: "already_processed" as const };
  const stage: RecoveryStage = input.status === "transcribing" ? "transcribe" : "extraction";
  await getDb().update(schema.profileInputRecovery).set({ state: "retrying", failedAttempts: 0, exhaustedAt: null,
    leaseUntil: null, leaseOwner: null, manualResets: sql`manual_resets + 1`, manualResetAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(schema.profileInputRecovery.sourceInputId, sourceInputId), eq(schema.profileInputRecovery.stage, stage)));
  await enqueue({ id: input.id, userId: input.userId, status: input.status });
  return { ok: true as const, stage };
}

/** После успешного разбора — сразу поставить следующее по порядку сообщение пользователя (если оно ждёт). */
export async function enqueueNextPendingInput(userId: string, sourceInputId: string, enqueue: EnqueueProfileJob = enqueuePendingInput) {
  const [next] = await loadPendingProfileInputs({ userId, after: sourceInputId, confirmedOnly: true, only: "notExhausted", limit: 1 });
  if (next && next.liveJobs === 0) await enqueue(next);
  return next?.id;
}

/**
 * Тик worker: поставить задачи застрявшим сообщениям. Повторная постановка безопасна: ключ одиночности
 * не даёт второй живой задачи, а уже обработанное сообщение разбор не повторяет (возвращает его версию).
 */
export async function dispatchStalledProfileInputs(
  enqueue: EnqueueProfileJob = enqueuePendingInput,
  scope: { userId?: string } = {}, // точечный запуск: восстановление одного пользователя, тесты
) {
  const due = await loadPendingProfileInputs({ ...scope, graceSeconds: RECOVERY_GRACE_SECONDS, only: "due", limit: 200 });
  for (const p of due) await enqueue(p);
  if (due.length) console.log(JSON.stringify({ event: "profile_inputs_recovered", count: due.length }));
  return due.map((p) => p.id);
}
