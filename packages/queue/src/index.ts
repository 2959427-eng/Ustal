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
  PROFILE_EXTRACTION: "profile_extraction",
  ORDER_EXTRACTION: "order_extraction",
  MODERATION: "moderation",
  EMBEDDING: "embedding",
  MATCHING_RUN: "matching_run",
  NOTIFICATION_DISPATCH: "notification_dispatch",
} as const;

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
