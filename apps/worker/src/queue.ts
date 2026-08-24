import PgBoss from "pg-boss";
import { loadEnv } from "@ustal/config";

/**
 * "Простая очередь задач на PostgreSQL" (раздел 3.2 / 12 ТЗ) — pg-boss поверх
 * того же Postgres, без Redis/BullMQ. Типы задач соответствуют пайплайнам
 * профиля и заказа из docs/matching.md.
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

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const env = loadEnv();
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("pg-boss error:", err);
  });
  await boss.start();
  bossInstance = boss;
  return boss;
}
