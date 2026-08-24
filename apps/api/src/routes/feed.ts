import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb } from "@ustal/database";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface FeedRow {
  [key: string]: unknown;
  order_id: string;
  normalized_title: string | null;
  normalized_description: string | null;
  city_id: string;
  price_minor: number | null;
  currency: string;
  created_at: string;
  score: string;
  match_type: string;
  explanation: string;
}

/**
 * Лента кандидата (docs/matching.md §13.5, docs/api.md «Лента и мои списки»).
 * Источник — уже посчитанные matching_candidates (см. worker
 * handleMatchingRun), а не запрос-на-лету: раздел 13 ТЗ требует объяснимый,
 * стабильный score, а не пересчёт при каждом открытии ленты. Число
 * исполнителей нигде не выводится (architecture.md §5 п.6).
 */
export default async function feedRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/feed", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(query.offset) || 0);

    const rows = await db.execute<FeedRow>(sql`
      SELECT
        o.id AS order_id,
        o.normalized_title,
        o.normalized_description,
        o.city_id,
        o.price_minor,
        o.currency,
        o.created_at,
        mc.score,
        mc.match_type,
        mc.explanation
      FROM matching_candidates mc
      JOIN matching_runs mr ON mr.id = mc.matching_run_id
      JOIN orders o ON o.id = mr.order_id
      WHERE mc.user_id = ${request.userId}
        AND o.status = 'published'
        AND mr.id = (
          SELECT mr2.id FROM matching_runs mr2
          WHERE mr2.order_id = o.id
          ORDER BY mr2.started_at DESC
          LIMIT 1
        )
      ORDER BY mc.score DESC, o.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return reply.send({
      items: [...rows].map((row) => ({
        orderId: row.order_id,
        title: row.normalized_title,
        description: row.normalized_description,
        cityId: row.city_id,
        priceMinor: row.price_minor,
        currency: row.currency,
        createdAt: row.created_at,
        score: Number(row.score),
        matchType: row.match_type,
        explanation: row.explanation,
      })),
      limit,
      offset,
    });
  });
}
