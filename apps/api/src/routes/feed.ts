import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb } from "@ustal/database";
import { MAX_ACTIVE_RESPONSES } from "@ustal/domain";
import { authorTitle } from "../lib/order-text.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface FeedRow {
  [key: string]: unknown;
  order_id: string;
  normalized_title: string | null;
  normalized_description: string | null;
  source_text: string | null;
  accepts_price_offers: boolean;
  city_id: string;
  price_minor: number | null;
  currency: string;
  created_at: string;
  match_type: string;
  explanation: string;
  photo_media_ids: string[] | null;
  assignment_status: string | null;
  contact_author_id: string | null;
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
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(query.limit) || DEFAULT_LIMIT),
    );
    const offset = Math.max(0, Number(query.offset) || 0);

    const rows = await db.execute<FeedRow>(sql`
      SELECT
        o.id AS order_id,
        o.normalized_title,
        o.normalized_description,
        o.source_text,
        o.accepts_price_offers,
        o.city_id,
        o.price_minor,
        o.currency,
        o.created_at,
        mc.match_type,
        mc.explanation,
        COALESCE((SELECT array_agg(om.media_id::text ORDER BY om.position) FROM order_media om WHERE om.order_id = o.id AND om.position >= 0), ARRAY[]::text[]) AS photo_media_ids,
        (SELECT oa.status FROM order_assignments oa WHERE oa.order_id = o.id AND oa.executor_id = ${request.userId} AND oa.status IN ('selected','in_progress') LIMIT 1) AS assignment_status,
        -- Контакт показываем, только пока отношения живые: заказ в работе/переговорах и (назначение selected/in_progress
        -- либо назначения нет, а отклик активен). После «Выполнено»/отмены/выбора другого кнопки связи исчезают.
        (SELECT o.author_id::text FROM contact_unlocks cu WHERE cu.order_id = o.id AND cu.executor_id = ${request.userId}
           AND o.status IN ('published','negotiating','in_progress')
           AND (
             EXISTS (SELECT 1 FROM order_assignments oa WHERE oa.order_id = o.id AND oa.executor_id = ${request.userId} AND oa.status IN ('selected','in_progress'))
             OR (
               NOT EXISTS (SELECT 1 FROM order_assignments oa WHERE oa.order_id = o.id AND oa.executor_id = ${request.userId})
               AND EXISTS (SELECT 1 FROM responses rr WHERE rr.order_id = o.id AND rr.executor_id = ${request.userId} AND rr.status = 'active')
             )
           )
         LIMIT 1) AS contact_author_id
      FROM matching_candidates mc
      JOIN matching_runs mr ON mr.id = mc.matching_run_id
      JOIN orders o ON o.id = mr.order_id
      WHERE mc.user_id = ${request.userId}
        AND (
          -- «Опубликован» и «Идут переговоры» видны всем подходящим исполнителям (в переговорах откликаться ещё можно);
          -- «В работе» закрывает заказ для остальных.
          o.status IN ('published', 'negotiating')
          -- Выбранный исполнитель не теряет заказ в «Возможностях»: он остаётся, пока идут переговоры / работа.
          OR EXISTS (SELECT 1 FROM order_assignments oa WHERE oa.order_id = o.id AND oa.executor_id = ${request.userId} AND oa.status IN ('selected','in_progress'))
        )
        -- Приём откликов закрыт (заказчик нажал «Достаточно откликов» или набран лимит): заказ остаётся только у тех,
        -- кто уже откликнулся или выбран.
        AND (
          (o.responses_closed_at IS NULL
            AND (SELECT count(*) FROM responses lr WHERE lr.order_id = o.id AND lr.status = 'active') < ${MAX_ACTIVE_RESPONSES})
          OR EXISTS (SELECT 1 FROM responses rr WHERE rr.order_id = o.id AND rr.executor_id = ${request.userId} AND rr.status = 'active')
          OR EXISTS (SELECT 1 FROM order_assignments oa WHERE oa.order_id = o.id AND oa.executor_id = ${request.userId} AND oa.status IN ('selected','in_progress'))
        )
        AND EXISTS (SELECT 1 FROM users u JOIN user_profiles up ON up.user_id=u.id WHERE u.id=${request.userId} AND u.status='active' AND up.city_id=o.city_id)
        AND o.author_id<>${request.userId}
        AND EXISTS (SELECT 1 FROM users au WHERE au.id=o.author_id AND au.status='active')
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=o.author_id AND b.blocked_id=${request.userId}) OR (b.blocker_id=${request.userId} AND b.blocked_id=o.author_id))
        -- «Простая задача» (2026-10-15) не требует профиля навыков: её получает и человек, ещё ничего о себе не рассказавший.
        AND (mc.match_type = 'opportunity' OR EXISTS (SELECT 1 FROM capability_profiles cp WHERE cp.user_id=${request.userId} AND cp.status='applied'))
        AND NOT EXISTS (
          SELECT 1 FROM matching_traces mt WHERE mt.matching_run_id=mr.id AND mt.user_id=${request.userId}
          AND mt.detail->>'profile_id' IS DISTINCT FROM (
            SELECT cp.id::text FROM capability_profiles cp WHERE cp.user_id=${request.userId} AND cp.status='applied' ORDER BY cp.profile_version DESC LIMIT 1
          )
        )
        AND NOT EXISTS (SELECT 1 FROM rematch_requests rq WHERE rq.user_id=${request.userId} AND rq.created_at>mr.started_at)
        AND NOT EXISTS (SELECT 1 FROM matching_documents md WHERE md.order_id=o.id AND md.created_at>mr.started_at)
        AND NOT EXISTS (SELECT 1 FROM matching_documents md JOIN capability_profiles cp ON cp.id=md.profile_id WHERE cp.user_id=${request.userId} AND cp.status='applied' AND md.created_at>mr.started_at)
        AND mr.id = (
          SELECT mr2.id FROM matching_runs mr2
          WHERE mr2.order_id = o.id AND mr2.completed_at IS NOT NULL
          ORDER BY mr2.started_at DESC
          LIMIT 1
        )
      -- Подходящие по навыкам и опыту — выше простых задач.
      ORDER BY (mc.match_type = 'opportunity') ASC, mc.score DESC, o.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return reply.send({
      items: [...rows].map((row) => ({
        orderId: row.order_id,
        // Заголовок — из текста автора, не придуманный AI.
        title: authorTitle(row.source_text) ?? row.normalized_title,
        // Показываем текст автора, а не пересказ AI: AI ничего не должен дописывать.
        description: row.source_text ?? row.normalized_description,
        cityId: row.city_id,
        priceMinor: row.price_minor,
        acceptsPriceOffers: row.accepts_price_offers,
        currency: row.currency,
        createdAt: row.created_at,
        // Internal score remains in SQL ORDER BY, never in the public contract.
        matchType: row.match_type,
        explanation: row.explanation,
        photoMediaIds: row.photo_media_ids ?? [],
        // Заполнено, только если вас выбрали: карточка показывает статус и кнопки связи.
        assignmentStatus: row.assignment_status,
        contactAuthorId: row.contact_author_id,
      })),
      limit,
      offset,
    });
  });
}
