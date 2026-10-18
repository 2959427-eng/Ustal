import PgBoss from "pg-boss";
import { loadEnv } from "@ustal/config";

/**
 * "Простая очередь задач на PostgreSQL" (раздел 3.2 / 12 ТЗ) — pg-boss поверх
 * того же Postgres, без Redis/BullMQ. Единая точка правды, используется и
 * `api` (ставит задачи), и `worker` (забирает задачи) — правило
 * docs/architecture.md §1: бизнес-логика/инфраструктура не дублируется между
 * ними. Раньше жила только в apps/worker — перенесено сюда, когда `api`
 * тоже стал ставить задачи (Фаза 2, POST /profile/inputs).
 */
export const JOB_TYPES = {
  // Пауза «Проверка транскрипции» (claude/pipeline-split-design.md): STT
  // выделен в отдельный job от extraction — voice-ввод сначала уходит сюда,
  // extraction ставится в очередь только явным подтверждением клиента
  // (POST /profile/inputs/{id}/confirm, POST /orders/{id}/confirm-transcript).
  PROFILE_TRANSCRIBE: "profile_transcribe",
  ORDER_TRANSCRIBE: "order_transcribe",
  PROFILE_EXTRACTION: "profile_extraction",
  // Phase 1 profile_facts (SHADOW): separate per-input fact extraction, independent of PROFILE_EXTRACTION.
  PROFILE_FACTS_EXTRACTION: "profile_facts_extraction",
  // Source revoke (2026-09-28): rebuild the AI profile from the owner's remaining (non-revoked) messages.
  PROFILE_REBUILD: "profile_rebuild",
  // Direct revoke/restore (2026-10-17): пересчёт вектора документа профиля после изменения навыков без AI extraction.
  PROFILE_EMBEDDING_REFRESH: "profile_embedding_refresh",
  ORDER_EXTRACTION: "order_extraction",
  MODERATION: "moderation",
  EMBEDDING: "embedding",
  MATCHING_RUN: "matching_run",
  NOTIFICATION_DISPATCH: "notification_dispatch",
} as const;

// Повторы задач обработки сообщений профиля (QA 2026-10-14, D2): по умолчанию pg-boss не повторяет
// упавшую задачу (retryLimit 0), и временный сбой AI или сети навсегда оставлял сообщение необработанным.
// Обработчики идемпотентны: extraction возвращает уже созданный по этому сообщению профиль, STT пишет
// расшифровку последним шагом.
export const PROFILE_JOB_OPTIONS = { retryLimit: 4, retryDelay: 5, retryBackoff: true } as const;

// Ключ одиночности задачи по сообщению профиля: pg-boss не создаёт вторую задачу с тем же ключом, пока
// первая ждёт, повторяется или выполняется. Поэтому API, повтор разбора после rebuild и восстановление
// застрявших сообщений (worker) могут ставить задачу независимо — дубликата не будет. По этому же ключу
// восстановление находит историю задач сообщения (profile-input-recovery.ts).
// Окно автоматического восстановления сообщений профиля (worker profile-input-recovery.ts). API по нему же
// сообщает клиенту, что сохранённое сообщение ещё обрабатывается (GET /profile/draft, mobile QA M11).
export const PROFILE_INPUT_RECOVERY_WINDOW_HOURS = 48;
export const profileJobKey = (job: "profile-extraction" | "profile-transcribe", sourceInputId: string) =>
  `${job}:${sourceInputId}`;
export const profileExtractionJobOptions = (sourceInputId: string) =>
  ({ ...PROFILE_JOB_OPTIONS, singletonKey: profileJobKey("profile-extraction", sourceInputId) });
export const profileTranscribeJobOptions = (sourceInputId: string) =>
  ({ ...PROFILE_JOB_OPTIONS, singletonKey: profileJobKey("profile-transcribe", sourceInputId) });

// Variant B (2026-10-15): единый срок для всех matching_run (публикация, rematch, волны). Основное лечение
// долгих поздних волн — кэш AI-вердиктов (worker ai-review-cache.ts); срок лишь ловит реально зависшую job.
// Обоснование значения — docs/evaluations/general-access-20261015/wave-load/CACHE-RESULTS.md.
export const MATCHING_RUN_EXPIRE_MINUTES = 30;
export const matchingRunJobOptions = (options: { retryLimit?: number } = {}) =>
  ({ expireInMinutes: MATCHING_RUN_EXPIRE_MINUTES, ...options });

let bossInstance: PgBoss | undefined;
let startPromise: Promise<PgBoss> | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  if (startPromise) return startPromise;

  const env = loadEnv();
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("pg-boss error:", err);
  });

  startPromise = boss.start().then(() => {
    bossInstance = boss;
    return boss;
  });
  return startPromise;
}
