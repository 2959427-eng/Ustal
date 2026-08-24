import type PgBoss from "pg-boss";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import {
  buildExplanation,
  classifyMatchType,
  computeScore,
  matchRequirements,
  type CandidateCapability,
  type CandidateResource,
  type OrderRequirement,
} from "@ustal/matching";

/**
 * drizzle's `sql` tag expands a plain JS array param into a comma-separated
 * TUPLE of placeholders ($1,$2,$3 — meant for VALUES lists), not a Postgres
 * array literal, so `col = ANY(${array})` fails with "requires array on
 * right side". This builds `ARRAY[$1::uuid,$2::uuid,...]` explicitly.
 */
function uuidArrayLiteral(ids: string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}

export interface MatchingRunJobData {
  orderId: string;
}

/**
 * Matching-пайплайн (docs/matching.md §13). Запускается по факту публикации
 * заказа (см. POST /orders/{id}/publish в apps/api/src/routes/orders.ts).
 *
 * 13.1 Жёсткие фильтры: другой город — не входит в кандидатский SQL вообще;
 * автор, заблокированные аккаунты, взаимные блокировки — исключены явно;
 * отсутствие обязательного требования — matchRequirements().missingMandatoryRequirement
 * (кандидат пропускается, а не штрафуется); регулируемый+неверифицированный —
 * см. ветку `regulated` ниже (в норме недостижима: регулируемый заказ не
 * проходит модерацию → не публикуется, но кандидатов быть не должно даже
 * при будущем ручном admin override).
 *
 * 13.2 Retrieval: canonical capability/resource match + pgvector semantic
 * similarity + learned_preferences + история завершённых заказов. Full-text
 * по normalized_description сознательно не реализован в MVP — embedding
 * similarity уже покрывает основной сценарий поиска по смыслу, а
 * canonical-match — точные совпадения; было бы дублирующим усложнением без
 * данных для его оценки на этом этапе.
 */
export async function handleMatchingRun(job: PgBoss.Job<MatchingRunJobData>) {
  const db = getDb();
  const config = getRuntimeConfig();

  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, job.data.orderId) });
  if (!order) throw new Error(`order ${job.data.orderId} not found`);
  if (order.status !== "published") {
    // Заказ мог стать cancelled/expired между enqueue и обработкой — не ошибка.
    return { orderId: order.id, candidatesCount: 0, skipped: true as const };
  }

  const [requirements, latestExtraction, orderEmbedding] = await Promise.all([
    db.query.orderRequirements.findMany({ where: eq(schema.orderRequirements.orderId, order.id) }),
    db.query.orderAiExtractions.findFirst({
      where: eq(schema.orderAiExtractions.orderId, order.id),
      orderBy: (t, { desc }) => desc(t.createdAt),
    }),
    db.query.orderEmbeddings.findFirst({ where: eq(schema.orderEmbeddings.orderId, order.id) }),
  ]);

  const regulated = Boolean((latestExtraction?.rawResult as { regulated?: boolean } | undefined)?.regulated);

  const [insertedRun] = await db
    .insert(schema.matchingRuns)
    .values({ orderId: order.id, startedAt: new Date() })
    .returning({ id: schema.matchingRuns.id });
  if (!insertedRun) throw new Error("Failed to create matching_runs row");
  const matchingRunId = insertedRun.id;

  async function finish(candidatesCount: number, extra: Record<string, unknown> = {}) {
    await db
      .update(schema.matchingRuns)
      .set({ completedAt: new Date(), candidatesCount })
      .where(eq(schema.matchingRuns.id, matchingRunId));
    return { orderId: order!.id, matchingRunId, candidatesCount, ...extra };
  }

  if (regulated) return finish(0, { regulated: true });

  const blockRows = await db.query.blocks.findMany({
    where: or(eq(schema.blocks.blockerId, order.authorId), eq(schema.blocks.blockedId, order.authorId)),
  });
  const blockedUserIds = new Set(
    blockRows.flatMap((b) => [b.blockerId, b.blockedId]).filter((uid) => uid !== order.authorId),
  );

  const candidateRows = await db.execute<{ user_id: string; profile_id: string }>(sql`
    SELECT DISTINCT ON (cp.user_id) cp.user_id, cp.id AS profile_id
    FROM capability_profiles cp
    JOIN user_profiles up ON up.user_id = cp.user_id
    JOIN users u ON u.id = cp.user_id
    WHERE up.city_id = ${order.cityId}
      AND cp.user_id <> ${order.authorId}
      AND u.status = 'active'
    ORDER BY cp.user_id, cp.profile_version DESC
  `);
  const candidates = [...candidateRows].filter((c) => !blockedUserIds.has(c.user_id));

  if (candidates.length === 0) return finish(0);

  const profileIds = candidates.map((c) => c.profile_id);
  const candidateUserIds = candidates.map((c) => c.user_id);
  const requirementNodeIds = requirements.map((r) => r.ontologyNodeId);

  const [similarityRows, capabilityRows, resourceRows, preferenceRows, completedRows] = await Promise.all([
    orderEmbedding
      ? db.execute<{ capability_profile_id: string; similarity: number }>(sql`
          SELECT pe.capability_profile_id, 1 - (pe.embedding <=> oe.embedding) AS similarity
          FROM profile_embeddings pe
          JOIN order_embeddings oe ON oe.order_id = ${order.id}
          WHERE pe.capability_profile_id = ANY(${uuidArrayLiteral(profileIds)})
        `)
      : Promise.resolve([]),
    db.query.userCapabilities.findMany({ where: inArray(schema.userCapabilities.capabilityProfileId, profileIds) }),
    db.query.userResources.findMany({ where: inArray(schema.userResources.capabilityProfileId, profileIds) }),
    db.query.learnedPreferences.findMany({
      where: and(inArray(schema.learnedPreferences.userId, candidateUserIds), isNull(schema.learnedPreferences.revokedAt)),
    }),
    requirementNodeIds.length > 0
      ? db.execute<{ executor_id: string; completed_count: number }>(sql`
          SELECT oa.executor_id, COUNT(DISTINCT oa.order_id)::int AS completed_count
          FROM order_assignments oa
          JOIN order_requirements orq ON orq.order_id = oa.order_id
          WHERE oa.executor_id = ANY(${uuidArrayLiteral(candidateUserIds)})
            AND oa.status = 'completed'
            AND orq.ontology_node_id = ANY(${uuidArrayLiteral(requirementNodeIds)})
          GROUP BY oa.executor_id
        `)
      : Promise.resolve([]),
  ]);

  const similarityByProfile = new Map(similarityRows.map((r) => [r.capability_profile_id, Number(r.similarity)]));
  const capabilitiesByProfile = new Map<string, CandidateCapability[]>();
  for (const cap of capabilityRows) {
    const list = capabilitiesByProfile.get(cap.capabilityProfileId) ?? [];
    list.push({ ontologyNodeId: cap.ontologyNodeId, label: cap.label, evidenceType: cap.evidenceType });
    capabilitiesByProfile.set(cap.capabilityProfileId, list);
  }
  const resourcesByProfile = new Map<string, CandidateResource[]>();
  for (const res of resourceRows) {
    const list = resourcesByProfile.get(res.capabilityProfileId) ?? [];
    list.push({ ontologyNodeId: res.ontologyNodeId, label: res.label });
    resourcesByProfile.set(res.capabilityProfileId, list);
  }
  const preferencesByUser = new Map<string, typeof preferenceRows>();
  for (const pref of preferenceRows) {
    const list = preferencesByUser.get(pref.userId) ?? [];
    list.push(pref);
    preferencesByUser.set(pref.userId, list);
  }
  const completedCountByUser = new Map(completedRows.map((r) => [r.executor_id, Number(r.completed_count)]));

  const requirementNodeIdSet = new Set(requirementNodeIds);
  const isSimpleLowRiskUnregulated = order.riskLevel === 0 && !regulated;

  const rowsToInsert: (typeof schema.matchingCandidates.$inferInsert)[] = [];

  for (const candidate of candidates) {
    const caps = capabilitiesByProfile.get(candidate.profile_id) ?? [];
    const resources = resourcesByProfile.get(candidate.profile_id) ?? [];
    const reqMatch = matchRequirements(requirements as OrderRequirement[], caps, resources);
    if (reqMatch.missingMandatoryRequirement) continue; // 13.1 hard filter

    // Защита от NaN: pgvector возвращает NaN (не ошибку) для cosine distance
    // между двумя нулевыми векторами — такое в проде не должно случиться (ни
    // один настоящий embedding-провайдер не отдаёт нулевой вектор), но
    // отравлять весь score NaN'ом на любой аномалии — хуже, чем занизить его
    // до 0 для этого одного компонента.
    const rawSimilarity = similarityByProfile.get(candidate.profile_id) ?? 0;
    const semanticSimilarity = Number.isFinite(rawSimilarity) ? Math.max(0, Math.min(1, rawSimilarity)) : 0;
    const completedCount = completedCountByUser.get(candidate.user_id) ?? 0;
    const hasSimilarCompletedWork = completedCount > 0;

    const relevantPrefs = (preferencesByUser.get(candidate.user_id) ?? []).filter((p) =>
      requirementNodeIdSet.has(p.ontologyNodeId),
    );
    const positiveWeight = relevantPrefs
      .filter((p) => p.signal === "positive")
      .reduce((sum, p) => sum + Number(p.weight), 0);
    const negativePreference = relevantPrefs.some((p) => p.signal === "negative");
    const behavioralPreference = Math.max(0, Math.min(1, positiveWeight));

    const scoring = computeScore(
      {
        explicitCapabilityMatch: reqMatch.explicitCapabilityMatch,
        inferredCapabilityMatch: reqMatch.inferredCapabilityMatch,
        resourceMatch: reqMatch.resourceMatch,
        semanticSimilarity,
        similarCompletedWork: hasSimilarCompletedWork ? 1 : 0,
        behavioralPreference,
        missingRequirement: false, // уже отфильтровано выше
        negativePreference,
        riskFlag: order.riskLevel > 0,
      },
      config.matching.weights,
    );

    if (scoring.score < config.matching.minimumRelevanceScore) continue;

    const matchType = classifyMatchType({
      hasExactCapability: reqMatch.hasExactCapability,
      hasSimilarCompletedWork,
      hasProbableFit: reqMatch.hasProbableFit,
      isSimpleLowRiskUnregulated,
      isRegulatedAndUnverified: regulated,
    });
    if (!matchType) continue;

    const explanation = buildExplanation({
      matchType,
      hasSimilarCompletedWork,
      matchedCapabilityLabels: reqMatch.matchedCapabilityLabels,
      matchedResourceLabels: reqMatch.matchedResourceLabels,
    });

    rowsToInsert.push({
      matchingRunId,
      userId: candidate.user_id,
      score: scoring.score.toString(),
      matchType,
      explanation,
      breakdown: scoring.breakdown,
    });
  }

  if (rowsToInsert.length > 0) {
    await db.insert(schema.matchingCandidates).values(rowsToInsert);
  }

  return finish(rowsToInsert.length);
}
