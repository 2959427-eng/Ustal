import { sql } from "drizzle-orm";
import type { getDb } from "@ustal/database";

/**
 * Два независимых рейтинга на аккаунт — как исполнитель и как заказчик:
 * средний балл 1–5 + количество оценок, отдельно по роли (`order_ratings.
 * to_role`), плюс фактическая история исходов по этой роли. Роли не
 * смешиваются. Рейтинг — только для показа в профиле; в matching и ленте
 * не участвует.
 */
export interface Reputation {
  executor: { rating: number | null; ratingCount: number; completed: number; notCompleted: number };
  customer: { rating: number | null; ratingCount: number; total: number; completed: number; cancelled: number };
}

interface Row {
  [key: string]: unknown;
  exec_completed: number;
  exec_not_completed: number;
  cust_total: number;
  cust_completed: number;
  cust_cancelled: number;
  exec_rating: string | null;
  exec_rating_count: number;
  cust_rating: string | null;
  cust_rating_count: number;
}

const round1 = (v: string | null): number | null => (v === null ? null : Math.round(Number(v) * 10) / 10);

export async function loadReputation(db: ReturnType<typeof getDb>, userId: string): Promise<Reputation> {
  const rows = await db.execute<Row>(sql`
    SELECT
      (SELECT count(*)::int FROM order_assignments WHERE executor_id = ${userId}::uuid AND status = 'completed') AS exec_completed,
      (SELECT count(*)::int FROM order_assignments WHERE executor_id = ${userId}::uuid AND status = 'not_completed') AS exec_not_completed,
      (SELECT count(*)::int FROM orders WHERE author_id = ${userId}::uuid) AS cust_total,
      (SELECT count(*)::int FROM orders WHERE author_id = ${userId}::uuid AND status = 'completed') AS cust_completed,
      -- «отменено»: снятые с публикации (не черновики) и несостоявшиеся заказы
      (SELECT count(*)::int FROM orders WHERE author_id = ${userId}::uuid
         AND (status = 'not_completed' OR (status = 'cancelled' AND published_at IS NOT NULL))) AS cust_cancelled,
      (SELECT avg(rating) FROM order_ratings WHERE to_user_id = ${userId}::uuid AND to_role = 'executor' AND rating IS NOT NULL) AS exec_rating,
      (SELECT count(*)::int FROM order_ratings WHERE to_user_id = ${userId}::uuid AND to_role = 'executor' AND rating IS NOT NULL) AS exec_rating_count,
      (SELECT avg(rating) FROM order_ratings WHERE to_user_id = ${userId}::uuid AND to_role = 'customer' AND rating IS NOT NULL) AS cust_rating,
      (SELECT count(*)::int FROM order_ratings WHERE to_user_id = ${userId}::uuid AND to_role = 'customer' AND rating IS NOT NULL) AS cust_rating_count
  `);
  const r = [...rows][0];
  return {
    executor: {
      rating: round1(r?.exec_rating ?? null),
      ratingCount: r?.exec_rating_count ?? 0,
      completed: r?.exec_completed ?? 0,
      notCompleted: r?.exec_not_completed ?? 0,
    },
    customer: {
      rating: round1(r?.cust_rating ?? null),
      ratingCount: r?.cust_rating_count ?? 0,
      total: r?.cust_total ?? 0,
      completed: r?.cust_completed ?? 0,
      cancelled: r?.cust_cancelled ?? 0,
    },
  };
}

/** Заказ из «Мои заказы» уходит в архив: оценка поставлена/пропущена либо заказ завершён без оценки. */
export function customerOrderArchived(status: string, myRatingDone: boolean): boolean {
  if (status === "completed") return myRatingDone;
  return ["not_completed", "closed", "expired"].includes(status);
}

/**
 * Отклик исполнителя уходит в архив сразу по факту исхода, не дожидаясь
 * его собственной оценки заказчика (она необязательна для архивации —
 * тот же принцип, что и у заказчика: архивация зависит от исхода заказа,
 * а не от факта оценки).
 */
export function executorResponseArchived(
  orderStatus: string | null,
  assignmentStatus: string | null,
  responseStatus: string,
): boolean {
  if (assignmentStatus === "completed" || assignmentStatus === "not_completed") return true;
  if (responseStatus === "withdrawn" || responseStatus === "not_selected") return true;
  return !!orderStatus && ["completed", "not_completed", "closed", "expired", "cancelled"].includes(orderStatus);
}
