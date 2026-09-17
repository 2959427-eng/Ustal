import type PgBoss from "pg-boss";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { loadEnv } from "@ustal/config";
import {
  cosine,
  evaluateSemantic,
  SEMANTIC_POLICY,
  type Fact,
} from "@ustal/matching";

export interface MatchingRunJobData {
  orderId: string;
}
const asFact = (f: typeof schema.matchingFacts.$inferSelect): Fact => ({
  ...f,
  confidence: Number(f.confidence),
  constraintType: f.constraintType as Fact["constraintType"],
  constraintScope: f.constraintScope as Fact["constraintScope"],
  resourceRole: f.resourceRole as Fact["resourceRole"],
});

/** City-first bounded retrieval, then evidence scoring. A completed run is published atomically. */
export async function handleMatchingRun(
  job: PgBoss.Job<MatchingRunJobData>,
): Promise<
  | { orderId: string; matchingRunId: string; candidatesCount: number }
  | { orderId: string; candidatesCount: number; skipped: true }
> {
  return getDb().transaction(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${job.data.orderId}, 1))`,
    );
    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, job.data.orderId),
    });
    if (!order) throw new Error("Matching order not found");
    if (order.status !== "published")
      return { orderId: order.id, candidatesCount: 0, skipped: true as const };
    const doc = await db.query.matchingDocuments.findFirst({
      where: eq(schema.matchingDocuments.orderId, order.id),
      orderBy: (t, { desc }) => desc(t.processedAt),
    });
    const extracted = await db.query.orderAiExtractions.findFirst({
      where: eq(schema.orderAiExtractions.orderId, order.id),
      orderBy: (t, { desc }) => desc(t.createdAt),
    });
    const legacyEmbedding = await db.query.orderEmbeddings.findFirst({
      where: eq(schema.orderEmbeddings.orderId, order.id),
    });
    const vector = doc?.embedding ?? legacyEmbedding?.embedding;
    const model = doc?.embeddingModel ?? legacyEmbedding?.embeddingModel;
    let requirements: Fact[] = doc
      ? (
          await db
            .select()
            .from(schema.matchingFacts)
            .where(eq(schema.matchingFacts.documentId, doc.id))
        ).map(asFact)
      : [];
    if (!doc)
      requirements = (
        await db
          .select()
          .from(schema.orderRequirements)
          .where(eq(schema.orderRequirements.orderId, order.id))
      ).map((r) => ({
        kind: r.requirementType.endsWith("resource")
          ? "resource"
          : "capability",
        phrase: "",
        nodeIds: [r.ontologyNodeId],
        mandatory: r.isMandatory,
        confidence: 1,
      }));
    const relations = await db.select().from(schema.ontologyRelations);
    const nodes = await db.select().from(schema.ontologyNodes);
    const activeIds = new Set(
      nodes.filter((n) => n.status === "active").map((n) => n.id),
    );
    requirements = requirements.map((f) => ({
      ...f,
      nodeIds: f.nodeIds.filter((id) => activeIds.has(id)),
    }));
    for (const n of nodes)
      if (n.parentId && activeIds.has(n.id) && activeIds.has(n.parentId))
        relations.push({
          id: `parent:${n.id}`,
          fromNodeId: n.id,
          toNodeId: n.parentId,
          relationType: "is_a",
        });
    const validRelations = relations.filter(
      (r) => activeIds.has(r.fromNodeId) && activeIds.has(r.toNodeId),
    );
    const requiredIds = requirements.flatMap((r) => r.nodeIds);
    const retrievalIds = [
      ...new Set([
        ...requiredIds,
        ...validRelations
          .filter((r) => requiredIds.includes(r.toNodeId))
          .map((r) => r.fromNodeId),
      ]),
    ];
    // Both streams are city-filtered; neither fetches every profile into the worker.
    // Exact SQL vector search within a city is the recall-safe fallback to ANN under filtering.
    const vecSql = vector
      ? sql`${JSON.stringify(vector)}::vector`
      : sql`NULL::vector`;
    const shortlist = await db.execute<{
      user_id: string;
      profile_id: string;
    }>(sql`
      WITH eligible AS MATERIALIZED (
        SELECT u.id user_id, cp.id profile_id, pe.embedding
        FROM user_profiles up JOIN users u ON u.id=up.user_id
        JOIN LATERAL (SELECT id FROM capability_profiles WHERE user_id=u.id AND status='applied' ORDER BY profile_version DESC LIMIT 1) cp ON true
        LEFT JOIN profile_embeddings pe ON pe.capability_profile_id=cp.id AND pe.embedding_model=${model ?? ""}
        WHERE up.city_id=${order.cityId} AND u.status='active' AND u.id<>${order.authorId}
          AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${order.authorId} AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=${order.authorId}))
      ), canonical AS (
        SELECT e.user_id,e.profile_id FROM eligible e
        JOIN user_capabilities uc ON uc.capability_profile_id=e.profile_id
        WHERE uc.ontology_node_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(retrievalIds)}::jsonb))
        GROUP BY e.user_id,e.profile_id ORDER BY count(DISTINCT uc.ontology_node_id) DESC,e.user_id LIMIT ${SEMANTIC_POLICY.shortlist}
      ), semantic AS (
        SELECT e.user_id,e.profile_id FROM profile_embeddings pe JOIN eligible e ON e.profile_id=pe.capability_profile_id
        WHERE pe.embedding_model=${model ?? ""} AND pe.embedding IS NOT NULL
        ORDER BY pe.embedding <=> ${vecSql} LIMIT ${SEMANTIC_POLICY.shortlist}
      ), city_fallback AS (
        SELECT user_id,profile_id FROM eligible WHERE embedding IS NOT NULL AND (SELECT count(*) FROM semantic)<${SEMANTIC_POLICY.shortlist}
        ORDER BY embedding <=> ${vecSql},user_id LIMIT ${SEMANTIC_POLICY.shortlist}
      ) SELECT * FROM canonical UNION SELECT * FROM semantic UNION SELECT * FROM city_fallback
    `);
    const city = await db.query.cities.findFirst({
      where: eq(schema.cities.id, order.cityId),
    });
    const localHour =
      order.desiredAt && city
        ? Number(
            new Intl.DateTimeFormat("en-GB", {
              hour: "numeric",
              hourCycle: "h23",
              timeZone: city.timezone,
            }).format(order.desiredAt),
          )
        : undefined;
    // ISO weekday numbering local to the order's city: 0=Mon..6=Sun.
    const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    const localWeekday =
      order.desiredAt && city
        ? WEEKDAY_INDEX[
            new Intl.DateTimeFormat("en-US", {
              weekday: "short",
              timeZone: city.timezone,
            }).format(order.desiredAt)
          ]
        : undefined;
    let candidatesCount = 0;
    const profileIds = shortlist.map((c) => c.profile_id),
      userIds = shortlist.map((c) => c.user_id);
    const documents = profileIds.length
      ? await db
          .select()
          .from(schema.matchingDocuments)
          .where(inArray(schema.matchingDocuments.profileId, profileIds))
          .orderBy(sql`${schema.matchingDocuments.processedAt} desc`)
      : [];
    const currentDocs = new Map<string, (typeof documents)[number]>();
    for (const d of documents)
      if (d.profileId && !currentDocs.has(d.profileId))
        currentDocs.set(d.profileId, d);
    const docIds = [...currentDocs.values()].map((d) => d.id);
    const allFacts = docIds.length
      ? await db
          .select()
          .from(schema.matchingFacts)
          .where(inArray(schema.matchingFacts.documentId, docIds))
      : [];
    const allCaps = profileIds.length
      ? await db
          .select()
          .from(schema.userCapabilities)
          .where(
            inArray(schema.userCapabilities.capabilityProfileId, profileIds),
          )
      : [];
    const allResources = profileIds.length
      ? await db
          .select()
          .from(schema.userResources)
          .where(inArray(schema.userResources.capabilityProfileId, profileIds))
      : [];
    const allEmbeddings = profileIds.length
      ? await db
          .select()
          .from(schema.profileEmbeddings)
          .where(
            inArray(schema.profileEmbeddings.capabilityProfileId, profileIds),
          )
      : [];
    const allPreferences = userIds.length
      ? await db.query.learnedPreferences.findMany({
          where: and(
            inArray(schema.learnedPreferences.userId, userIds),
            sql`${schema.learnedPreferences.revokedAt} is null`,
          ),
        })
      : [];
    const watermarks = userIds.length ? await db.select({ userId: schema.rematchRequests.userId,
      requestedAt: schema.rematchRequests.requestedAt }).from(schema.rematchRequests)
      .where(inArray(schema.rematchRequests.userId, userIds)) : [];
    const sorted = (items: unknown[]) => items.map((v) => JSON.stringify(v)).sort();
    const inputHash = createHash("sha256").update(JSON.stringify({
      policy: SEMANTIC_POLICY, reviewModel: loadEnv().AI_MODEL_SEMANTIC_REVIEW, order, localHour, localWeekday, model, vector, requirements: sorted(requirements),
      extraction: extracted?.rawResult, nodes: sorted(nodes), relations: sorted(validRelations),
      shortlist: sorted(shortlist), documents: sorted([...currentDocs.values()]),
      facts: sorted(allFacts), capabilities: sorted(allCaps), resources: sorted(allResources),
      embeddings: sorted(allEmbeddings), preferences: sorted(allPreferences), watermarks: sorted(watermarks),
    })).digest("hex");
    const latest = await db.query.matchingRuns.findFirst({
      where: and(eq(schema.matchingRuns.orderId, order.id), sql`${schema.matchingRuns.completedAt} is not null`),
      orderBy: (t, { desc }) => desc(t.startedAt),
    });
    // Reuse only the latest snapshot. A -> B -> A must publish a new latest run.
    if (latest?.inputHash === inputHash)
      return { orderId: order.id, matchingRunId: latest.id, candidatesCount: latest.candidatesCount ?? 0 };
    const [run] = await db.insert(schema.matchingRuns)
      .values({ orderId: order.id, startedAt: new Date(), inputHash }).returning();
    if (!run) throw new Error("Failed to start matching run");
    let reviews = 0;
    for (const candidate of [...shortlist].sort((a, b) => a.user_id.localeCompare(b.user_id))) {
      const profileDoc = currentDocs.get(candidate.profile_id);
      let facts: Fact[] = [];
      if (profileDoc)
        facts = allFacts
          .filter((f) => f.documentId === profileDoc.id)
          .map(asFact);
      else {
        const caps = allCaps.filter(
          (c) => c.capabilityProfileId === candidate.profile_id,
        );
        const resources = allResources.filter(
          (r) => r.capabilityProfileId === candidate.profile_id,
        );
        facts = [
          ...caps.map((c) => ({
            kind: "capability",
            phrase: c.label,
            nodeIds: [c.ontologyNodeId],
            mandatory: false,
            confidence: Number(c.confidence),
          })),
          ...resources.map((r) => ({
            kind: "resource",
            phrase: r.label,
            nodeIds: [r.ontologyNodeId],
            mandatory: false,
            confidence: Number(r.confidence),
          })),
        ];
      }
      facts = facts.map((f) => ({
        ...f,
        nodeIds: f.nodeIds.filter((id) => activeIds.has(id)),
      }));
      const pe = allEmbeddings.find(
        (p) => p.capabilityProfileId === candidate.profile_id,
      );
      const compatible =
        (profileDoc?.embeddingModel ?? pe?.embeddingModel) === model;
      if (!compatible) facts = facts.map((f) => ({ ...f, embedding: null }));
      const preferences = allPreferences.filter(
        (p) => p.userId === candidate.user_id,
      );
      const evaluation = {
        capabilities: facts,
        requirements,
        relations: validRelations,
        documentSimilarity: compatible
          ? cosine(profileDoc?.embedding ?? pe?.embedding, vector)
          : 0,
        riskLevel: order.riskLevel,
        localWeekday,
        regulated:
          Boolean(
            (extracted?.rawResult as { regulated?: boolean })?.regulated,
          ) || nodes.some((n) => n.regulated && requiredIds.includes(n.id)),
        localHour,
        negativePreference: preferences.some(
          (p) =>
            p.signal === "negative" && requiredIds.includes(p.ontologyNodeId),
        ),
        reviewRequired:
          order.riskLevel > 0 ||
          Boolean((extracted?.rawResult as { requiresQualification?: boolean })?.requiresQualification),
      };
      let result = evaluateSemantic(evaluation);
      const needsSourceReview =
        ["insufficient_capability_evidence", "physical_compatibility_unverified", "safety_review_required"].includes(result.reason);
      if (needsSourceReview &&
        facts.some((f) => f.kind === "capability" && f.confidence >= 0.5) && requirements.some((f) => f.kind === "capability")) {
        if (reviews >= SEMANTIC_POLICY.reviewLimit) throw new Error("Semantic review budget exceeded; run not published");
        reviews++;
        const meta = { operationType: "semantic_pair_review", traceId: job.id, promptVersion: "semantic-review-v5-safety", schemaVersion: "v1" };
        const started = new Date();
        const reviewed = await getAiProviders().extraction.reviewSemantic({
          profile: profileDoc?.sourceText ? [profileDoc.sourceText] : facts.filter((f) => f.kind === "capability" && f.confidence >= 0.5).map((f) => f.phrase),
          order: doc?.sourceText ? [doc.sourceText] : requirements.filter((f) => f.kind === "capability").map((f) => f.phrase),
        }, meta);
        await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { result: reviewed }));
        result = evaluateSemantic({ ...evaluation, semanticReview: reviewed.data });
      }
      await db
        .insert(schema.matchingTraces)
        .values({
          matchingRunId: run.id,
          userId: candidate.user_id,
          decision: result.classification,
          detail: {
            ...result.trace,
            profile_id: candidate.profile_id,
            profile_document_id: profileDoc?.id ?? null,
            order_document_id: doc?.id ?? null,
          },
        });
      if (!result.matchType) continue;
      await db
        .insert(schema.matchingCandidates)
        .values({
          matchingRunId: run.id,
          userId: candidate.user_id,
          score: String(result.score),
          matchType: result.matchType,
          explanation:
            result.classification === "exact"
              ? "У вас есть подходящие навыки для этой задачи"
              : "По описанию ваших возможностей эта задача может вам подойти",
          breakdown: result.trace,
        });
      candidatesCount++;
    }
    // Recheck status under row lock: cancellation during scoring must not publish fresh matches.
    const [current] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id))
      .for("update");
    if (current?.status !== "published")
      throw new Error("Order closed during matching");
    await db
      .update(schema.matchingRuns)
      .set({ completedAt: new Date(), candidatesCount })
      .where(eq(schema.matchingRuns.id, run.id));
    return { orderId: order.id, matchingRunId: run.id, candidatesCount };
  });
}
