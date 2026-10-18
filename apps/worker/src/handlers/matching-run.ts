import { reviewProfileText } from "../profile-restrictions.js";
import type PgBoss from "pg-boss";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { buildAiRunRecord, getAiProviders, reviewPipelineFingerprint, SEMANTIC_REVIEW_PROMPT_VERSION, type AiCallResult } from "@ustal/ai";
import type { SemanticReview } from "@ustal/validation";
import { loadEnv } from "@ustal/config";
import { MAX_DELIVERY_WAVES } from "@ustal/domain";
import type { OrderAccess } from "@ustal/validation";
import { deliverGeneralAccess, generalAccessPoolFingerprint, usesGeneralAccess, type PriorOutcome } from "../general-access.js";
import { readCachedReview, reviewCacheKey, storeCachedReview, type ReviewCacheIdentity } from "../ai-review-cache.js";
import {
  cosine,
  evaluateSemantic,
  SEMANTIC_POLICY,
  type Fact,
} from "@ustal/matching";

export interface MatchingRunJobData {
  orderId: string;
}
/** Order resource roles that are not something the executor must have (never a retrieval query). */
const NON_ASSET_ORDER_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);
const asFact = (f: typeof schema.matchingFacts.$inferSelect): Fact => ({
  ...f,
  confidence: Number(f.confidence),
  constraintType: f.constraintType as Fact["constraintType"],
  constraintScope: f.constraintScope as Fact["constraintScope"],
  resourceRole: f.resourceRole as Fact["resourceRole"],
});

/** City-first bounded retrieval, then evidence scoring. A completed run is published atomically. */
/** Source review gate: structured facts or, as a fallback, both source texts (review decides). */
export function shouldRunSourceReview(input: { needsSourceReview: boolean; structuredEvidence: boolean; sourceTextsAvailable: boolean }): boolean {
  return input.needsSourceReview && (input.structuredEvidence || input.sourceTextsAvailable);
}

export type SourceReviewOutcome =
  | { status: "ok"; result: AiCallResult<SemanticReview> }
  | { status: "failed"; error: { name: string; code: string | number | null; message: string }; cause: Error };

/**
 * One candidate's source review. Never throws: a technical failure (timeout, provider error, malformed
 * JSON, schema/evidence validation, exhausted repair attempts) is NOT evidence of incompatibility and must
 * not abort matching of the other candidates. Logged for diagnostics without source text (evidence errors
 * carry profile/order quotes in `diagnostic`, which is deliberately not copied).
 */
export async function runSourceReview(
  call: () => Promise<AiCallResult<SemanticReview>>,
  context: { orderId: string; userId: string },
): Promise<SourceReviewOutcome> {
  try {
    return { status: "ok", result: await call() };
  } catch (thrown) {
    const cause = thrown instanceof Error ? thrown : new Error(String(thrown));
    const raw = (cause as { code?: unknown; status?: unknown }).code ?? (cause as { status?: unknown }).status;
    const error = {
      name: cause.name,
      code: typeof raw === "string" || typeof raw === "number" ? raw : null,
      message: cause.message.slice(0, 300),
    };
    console.error(JSON.stringify({ event: "semantic_review_failed", ...context, error }));
    return { status: "failed", error, cause };
  }
}

/**
 * review ok + proven conflict -> reject; review ok + no conflict -> keep; review failed -> the pre-review
 * deterministic decision with review-only gates waived (fail-open for recall, trace.review_unverified),
 * never counted as an AI-confirmed match and never cancelling an independent hard rule.
 */
export function decideAfterReview(
  evaluation: Parameters<typeof evaluateSemantic>[0],
  outcome: SourceReviewOutcome,
) {
  return outcome.status === "ok"
    ? evaluateSemantic({ ...evaluation, semanticReview: outcome.result.data })
    : evaluateSemantic({ ...evaluation, reviewUnavailable: true });
}

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
    // Loaded before the legacy-requirements fallback below, which derives resourceType
    // from these nodes (previously declared after use -> TDZ ReferenceError on that path).
    const relations = await db.select().from(schema.ontologyRelations);
    const nodes = await db.select().from(schema.ontologyNodes);

    // Helper: Derive resourceType by traversing ontology hierarchy to root
    const deriveResourceTypeFromNode = (nodeId: string): Fact['resourceType'] => {
      const physicalResourceTypes = ['vehicle', 'tool', 'equipment', 'property', 'space'];
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      const visited = new Set<string>();
      let current: typeof nodes[0] | undefined = nodeMap.get(nodeId);
      
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        // Check if this node's canonicalKey matches a physical category
        if (physicalResourceTypes.includes(current.canonicalKey)) {
          return current.canonicalKey as Fact['resourceType'];
        }
        // Move to parent
        if (current.parentId && activeIds.has(current.parentId)) {
          current = nodeMap.get(current.parentId);
        } else {
          break;
        }
      }
      
      // Not a physical resource type
      return null;
    };
    const activeIds = new Set(
      nodes.filter((n) => n.status === "active").map((n) => n.id),
    );
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
        resourceType: r.requirementType.endsWith("resource")
          ? deriveResourceTypeFromNode(r.ontologyNodeId)
          : undefined,
      }));
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
    // Resources the order needs, by meaning (2026-10-05). A resource with no ontology node
    // ("кофемашина", "генератор", "самолёт") has no node to hit in canonical_resource, and the
    // profile document embedding is built from capabilities only, so without this stream a
    // resource-only profile was reachable only through the city fallback.
    const resourceQueryVectors = requirements
      .filter((f) => f.kind === "resource" && !NON_ASSET_ORDER_ROLES.has(f.resourceRole ?? "") && f.embedding?.length)
      .map((f) => sql`(${JSON.stringify(f.embedding)}::vector)`);
    const resourceQuerySql = resourceQueryVectors.length
      ? sql`SELECT v FROM (VALUES ${sql.join(resourceQueryVectors, sql`,`)}) q(v)`
      : sql`SELECT NULL::vector v WHERE false`;
    // Skills the order asks for, by meaning (2026-10-06). A narrow or differently chosen ontology
    // node (profile "events" vs order "assembly") and a diluted whole-profile embedding must not
    // hide a relevant skill before evaluation: each positive skill fact is ranked on its own.
    // Discovery only — evaluateSemantic and the source review still decide compatibility.
    const capabilityQueryVectors = requirements
      .filter((f) => f.kind === "capability" && f.constraintType !== "exclusion" && f.embedding?.length)
      .map((f) => sql`(${JSON.stringify(f.embedding)}::vector)`);
    const capabilityQuerySql = capabilityQueryVectors.length
      ? sql`SELECT v FROM (VALUES ${sql.join(capabilityQueryVectors, sql`,`)}) q(v)`
      : sql`SELECT NULL::vector v WHERE false`;
    // Показ волнами (2026-10-15, @ustal/domain order-delivery): волна N расширяет каждый поток отбора до N × shortlist
    // и бюджет review до N × reviewLimit. Волна 1 — прежний подбор без изменений.
    const wave = Math.max(1, Math.min(order.deliveryWave ?? 1, MAX_DELIVERY_WAVES));
    const shortlistLimit = SEMANTIC_POLICY.shortlist * wave;
    const reviewLimit = SEMANTIC_POLICY.reviewLimit * wave;
    const shortlist = await db.execute<{
      user_id: string;
      profile_id: string;
    }>(sql`
      WITH eligible AS MATERIALIZED (
        -- embedding_stale (2026-10-17): вектор профиля устарел после прямого действия кнопкой — не положительный сигнал
        -- (ни semantic/city_fallback, ни stale_model_fallback) до пересчёта; канонические/фактовые пути работают как прежде.
        SELECT u.id user_id, cp.id profile_id, CASE WHEN cp.embedding_stale THEN NULL ELSE pe.embedding END embedding, cp.embedding_stale stale
        FROM user_profiles up JOIN users u ON u.id=up.user_id
        JOIN LATERAL (SELECT id, embedding_stale FROM capability_profiles WHERE user_id=u.id AND status='applied' ORDER BY profile_version DESC LIMIT 1) cp ON true
        LEFT JOIN profile_embeddings pe ON pe.capability_profile_id=cp.id AND pe.embedding_model=${model ?? ""}
        WHERE up.city_id=${order.cityId} AND u.status='active' AND u.id<>${order.authorId}
          AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${order.authorId} AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=${order.authorId}))
      ), canonical AS (
        SELECT e.user_id,e.profile_id FROM eligible e
        JOIN user_capabilities uc ON uc.capability_profile_id=e.profile_id
        WHERE uc.ontology_node_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(retrievalIds)}::jsonb))
        GROUP BY e.user_id,e.profile_id ORDER BY count(DISTINCT uc.ontology_node_id) DESC,e.user_id LIMIT ${shortlistLimit}
      ), canonical_resource AS (
        -- Structural resource-only match never depended on embeddings and must not start
        -- depending on them now: a candidate whose only signal is a matching resource
        -- (no capability fact) is retrievable purely by ontology_node_id, same as canonical.
        SELECT e.user_id,e.profile_id FROM eligible e
        JOIN user_resources ur ON ur.capability_profile_id=e.profile_id
        WHERE ur.ontology_node_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(retrievalIds)}::jsonb))
        GROUP BY e.user_id,e.profile_id ORDER BY count(DISTINCT ur.ontology_node_id) DESC,e.user_id LIMIT ${shortlistLimit}
      ), resource_query AS (${resourceQuerySql}
      ), resource_semantic AS (
        -- Any owned resource fact (with or without an ontology node) ranked by its own phrase
        -- embedding against the order's resource requirements: exact search inside the already
        -- city/status/block-filtered eligible set, bounded by the same shortlist LIMIT.
        SELECT e.user_id,e.profile_id FROM eligible e
        JOIN LATERAL (SELECT md.id FROM matching_documents md WHERE md.profile_id=e.profile_id ORDER BY md.created_at DESC LIMIT 1) d ON true
        JOIN matching_facts mf ON mf.document_id=d.id
        CROSS JOIN resource_query q
        WHERE mf.kind='resource' AND mf.embedding IS NOT NULL AND mf.constraint_type<>'exclusion'
          AND mf.resource_role NOT IN ('missing','provided_by_customer','compatibility')
        GROUP BY e.user_id,e.profile_id ORDER BY min(mf.embedding <=> q.v),e.user_id LIMIT ${shortlistLimit}
      ), capability_query AS (${capabilityQuerySql}
      ), capability_semantic AS (
        -- Positive skill facts of the current profile document, ranked by their own phrase
        -- embedding against the order's skill requirements; same bounded shape as resource_semantic.
        SELECT e.user_id,e.profile_id FROM eligible e
        JOIN LATERAL (SELECT md.id FROM matching_documents md WHERE md.profile_id=e.profile_id ORDER BY md.created_at DESC LIMIT 1) d ON true
        JOIN matching_facts mf ON mf.document_id=d.id
        CROSS JOIN capability_query q
        WHERE mf.kind='capability' AND mf.embedding IS NOT NULL AND mf.constraint_type<>'exclusion' AND mf.confidence>=0.5
        GROUP BY e.user_id,e.profile_id ORDER BY min(mf.embedding <=> q.v),e.user_id LIMIT ${shortlistLimit}
      ), semantic AS (
        SELECT e.user_id,e.profile_id FROM profile_embeddings pe JOIN eligible e ON e.profile_id=pe.capability_profile_id
        WHERE pe.embedding_model=${model ?? ""} AND pe.embedding IS NOT NULL AND NOT e.stale
        ORDER BY pe.embedding <=> ${vecSql} LIMIT ${shortlistLimit}
      ), city_fallback AS (
        SELECT user_id,profile_id FROM eligible WHERE embedding IS NOT NULL AND (SELECT count(*) FROM semantic)<${shortlistLimit}
        ORDER BY embedding <=> ${vecSql},user_id LIMIT ${shortlistLimit}
      ), stale_model_fallback AS (
        -- Bounded, model-agnostic safety net: a candidate whose most recent embedding was
        -- computed under a DIFFERENT/older embedding_model has NULL eligible.embedding (the
        -- LEFT JOIN above is filtered to the CURRENT model) and was previously invisible to
        -- both semantic and city_fallback, which both require it. No ANN here -- a stale
        -- vector cannot be ranked against the current model's vecSql at all -- bounded by the
        -- same shortlist LIMIT off the already city/status/block-filtered eligible set, so
        -- this stays a bounded indexed lookup, never a full scan.
        SELECT e.user_id,e.profile_id FROM eligible e
        WHERE e.embedding IS NULL AND NOT e.stale
          AND EXISTS(SELECT 1 FROM profile_embeddings pe2 WHERE pe2.capability_profile_id=e.profile_id)
        LIMIT ${shortlistLimit}
      ) SELECT * FROM canonical UNION SELECT * FROM canonical_resource UNION SELECT * FROM resource_semantic UNION SELECT * FROM capability_semantic UNION SELECT * FROM semantic
        UNION SELECT * FROM city_fallback UNION SELECT * FROM stale_model_fallback
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
    const staleProfiles = new Set(profileIds.length
      ? (await db.select({ id: schema.capabilityProfiles.id }).from(schema.capabilityProfiles)
          .where(and(inArray(schema.capabilityProfiles.id, profileIds), eq(schema.capabilityProfiles.embeddingStale, true)))).map((r) => r.id)
      : []);
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
    // Служебные поля показа (время волны, исчерпание, закрытие приёма) не меняют подбор: номер волны — меняет.
    const { deliveryWaveAt: _waveAt, deliveryExhaustedAt: _exhausted, responsesClosedAt: _closed, deliveredWave: _delivered, ...hashedOrder } = order;
    void _waveAt; void _exhausted; void _closed; void _delivered;
    const sorted = (items: unknown[]) => items.map((v) => JSON.stringify(v)).sort();
    // Whole-run validity (fix 2026-10-15): the run is reusable only if everything that decides the delivery is
    // unchanged — including the real AI review pipeline and, for a general-access order, the whole eligible city pool
    // (people outside the ordinary shortlist, their restrictions and eligibility data). See generalAccessPoolFingerprint.
    const runAccess = (extracted?.rawResult as { access?: OrderAccess | null } | undefined)?.access ?? null;
    const reviewPipeline = reviewPipelineFingerprint("semantic_pair_review");
    const generalAccessInputs = usesGeneralAccess(runAccess) ? {
      pool: await generalAccessPoolFingerprint(db, { cityId: order.cityId, authorId: order.authorId }),
      orderDocument: doc?.sourceText ?? null,
      refusalPipeline: reviewPipelineFingerprint("general_access_refusal_check"),
    } : null;
    const pipelineProvable = Boolean(reviewPipeline) && (!generalAccessInputs || Boolean(generalAccessInputs.refusalPipeline));
    const inputHash = createHash("sha256").update(JSON.stringify({
      reviewPipeline, generalAccess: generalAccessInputs,
      policy: SEMANTIC_POLICY, reviewPromptVersion: SEMANTIC_REVIEW_PROMPT_VERSION, reviewModel: loadEnv().AI_MODEL_SEMANTIC_REVIEW, order: hashedOrder, localHour, localWeekday, model, vector, requirements: sorted(requirements),
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
    if (pipelineProvable && latest?.inputHash === inputHash)
      return { orderId: order.id, matchingRunId: latest.id, candidatesCount: latest.candidatesCount ?? 0 };
    const [run] = await db.insert(schema.matchingRuns)
      .values({ orderId: order.id, startedAt: new Date(), inputHash }).returning();
    if (!run) throw new Error("Failed to start matching run");
    // `reviews` = real AI review calls in this run (the wave budget); cached verdicts do not consume it.
    let reviews = 0;
    let reviewCacheHits = 0;
    let reviewFailures = 0;
    // Verdicts that are usable now but not stable (degraded review, failed general-access check): never frozen by reuse.
    let unstableResults = 0;
    // «Простые задачи» (2026-10-15): кто получил заказ обычным подбором и чем закончилась оценка остальных.
    const matchedUsers = new Set<string>();
    const evaluatedUsers = new Map<string, PriorOutcome>();
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
            resourceType: r.resourceType,
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
        // Устаревший вектор профиля (embedding_stale) — не сигнал: 0, как у несовместимой модели.
        documentSimilarity: compatible && !staleProfiles.has(candidate.profile_id)
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
        ["insufficient_capability_evidence", "physical_compatibility_unverified", "safety_review_required", "scope_unverified"].includes(result.reason) ||
        // Broad exact nodes cannot establish compliance with source-only constraints.
        Boolean(result.matchType && profileDoc?.sourceText && doc?.sourceText);
      // A profile can express suitability purely through a possessed resource ("есть газель
      // с гидробортом", "есть шуруповёрт и набор инструментов") with no separate capability
      // sentence. Such a resource fact must also unlock the semantic review, otherwise a
      // resource-only profile can never pass the physical/safety-review gate at all.
      // Deferred, not rejected: a candidate whose decision genuinely depends on LLM review
      // (safety/physical/capability-evidence gate) must never be recorded as a normal reject
      // just because this run's review budget ran out — that would look like a real mismatch
      // and the candidate would never be picked up again. No schema change needed: `decision`
      // is a free varchar and `detail` is jsonb, so a distinct sentinel + flag is enough to
      // tell "genuinely rejected" apart from "needs review, budget exhausted this run" without
      // a migration. The candidate still never enters matching_candidates (never shown to the
      // user unverified) and a future matching run — which starts its own fresh 100-review
      // budget — evaluates them again from scratch and can resolve it either way.
      let deferredReviewBudget = false;
      let reviewFailure: Extract<SourceReviewOutcome, { status: "failed" }>["error"] | null = null;
      // Empty/insufficient structured extraction is not evidence of incompatibility:
      // when both source texts exist, the source review decides (never an automatic match).
      const structuredEvidence =
        facts.some((f) =>
          (f.kind === "capability" && f.confidence >= 0.5) ||
          (f.kind === "resource" && f.resourceRole === "available"),
        ) && requirements.some((f) => f.kind === "capability" || f.kind === "resource");
      const sourceTextsAvailable = Boolean(profileDoc?.sourceText && doc?.sourceText);
      let reviewCacheHit = false;
      // Ограничения, которые пользователь позже сам снял, ревью не показываются (profile-restrictions.ts).
      const reviewProfile = profileDoc?.sourceText ? [reviewProfileText(profileDoc.sourceText, facts)] : facts.filter((f) => f.kind === "capability" && f.confidence >= 0.5).map((f) => f.phrase);
      // Пользователь убрал всё: эффективный профиль пуст — ревью нечего проверять (модель на пустом тексте отвечает
      // «ничто не исключает» → ложная доставка). Решение остаётся детерминированным (без доказательств — нет совпадения);
      // general-заказы по-прежнему доходят своим путём general access (live E2E 2026-10-18).
      const profileEvidence = reviewProfile.some((t) => t.trim().length > 0);
      if (profileEvidence && shouldRunSourceReview({ needsSourceReview, structuredEvidence, sourceTextsAvailable })) {
        const reviewInput = {
          profile: reviewProfile,
          order: doc?.sourceText ? [doc.sourceText] : requirements.filter((f) => f.kind === "capability").map((f) => f.phrase),
          // Only when the user lifted/replaced a restriction; every other review call is byte-identical to before.
          ...(facts.some((f) => f.kind === "superseded") ? { profileHasUpdates: true } : {}),
        };
        // Variant B: the same AI input (profile text, order text, flag) + prompt/schema/model -> the same memoized verdict.
        const cacheIdentity: ReviewCacheIdentity = { reviewType: "semantic_pair_review", promptVersion: SEMANTIC_REVIEW_PROMPT_VERSION, schemaVersion: "v1", input: reviewInput };
        const cacheKey = reviewCacheKey(cacheIdentity);
        const cached = await readCachedReview<SemanticReview>(cacheKey);
        if (cached) {
          reviewCacheHit = true;
          reviewCacheHits++;
          result = decideAfterReview(evaluation, { status: "ok", result: { data: cached, provider: "cache", model: "cache", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } });
        } else if (reviews < reviewLimit) {
          reviews++;
          const meta = { operationType: "semantic_pair_review", traceId: job.id, promptVersion: SEMANTIC_REVIEW_PROMPT_VERSION, schemaVersion: "v1" };
          const started = new Date();
          let outcome = await runSourceReview(() => getAiProviders().extraction.reviewSemantic(reviewInput, meta), { orderId: order.id, userId: candidate.user_id });
          await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started,
            outcome.status === "ok" ? { result: outcome.result } : { error: outcome.cause }));
          if (outcome.status === "failed") { reviewFailure = outcome.error; reviewFailures++; }
          else if (outcome.result.degraded) unstableResults++;
          // Technical failures and degraded verdicts are never memoized. On a concurrent identical write the
          // first stored verdict wins, so every run uses one consistent decision for this key.
          else if (!outcome.result.degraded)
            outcome = { status: "ok", result: { ...outcome.result, data: await storeCachedReview(cacheKey, cacheIdentity, outcome.result.data) } };
          result = decideAfterReview(evaluation, outcome);
        } else {
          deferredReviewBudget = true;
        }
      }
      await db
        .insert(schema.matchingTraces)
        .values({
          matchingRunId: run.id,
          userId: candidate.user_id,
          decision: deferredReviewBudget ? "deferred_review_budget" : result.classification,
          detail: {
            ...result.trace,
            ...(deferredReviewBudget ? { deferred: true, deferredReason: "review_budget_exhausted" } : {}),
            ...(reviewCacheHit ? { review_cache: "hit" } : {}),
            // Internal only (matching_traces/breakdown are never sent to clients): review not completed.
            ...(reviewFailure ? { review_status: "failed", review_error: reviewFailure } : {}),
            profile_id: candidate.profile_id,
            profile_document_id: profileDoc?.id ?? null,
            order_document_id: doc?.id ?? null,
          },
        });
      evaluatedUsers.set(candidate.user_id, { reason: deferredReviewBudget ? "deferred_review_budget" : result.reason,
        reviewConflictKind: (result.trace as { semantic_review?: { hardConflict?: { kind?: string } | null } | null })?.semantic_review?.hardConflict?.kind ?? null,
        profileId: candidate.profile_id });
      if (deferredReviewBudget || !result.matchType) continue;
      matchedUsers.add(candidate.user_id);
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
    // «Простые задачи» (2026-10-15): дополнительный путь показа для заказа general без явных требований — только тем,
    // кто не получил заказ обычным подбором; места — после обычного подбора, тем же лимитом волны.
    const access = (extracted?.rawResult as { access?: (OrderAccess & { version?: string }) | null } | undefined)?.access ?? null;
    let generalExhausted = true;
    let generalStats = { refusalChecks: 0, refusalCacheHits: 0 };
    if (usesGeneralAccess(access)) {
      const general = await deliverGeneralAccess(db, {
        orderId: order.id, runId: run.id, orderText: doc?.sourceText ?? order.sourceText ?? "", access: access!,
        cityId: order.cityId, authorId: order.authorId, matched: matchedUsers, evaluated: evaluatedUsers,
        slots: shortlistLimit - matchedUsers.size, reviewBudget: Math.max(0, reviewLimit - reviews), traceId: job.id,
        hardReason: (facts) => evaluateSemantic({ capabilities: facts as unknown as Fact[], requirements, relations: validRelations, documentSimilarity: 0,
          riskLevel: order.riskLevel, localWeekday, regulated: false, localHour, negativePreference: false, reviewRequired: false }).reason,
      });
      candidatesCount += general.added;
      generalExhausted = general.exhausted;
      generalStats = { refusalChecks: general.reviews, refusalCacheHits: general.cacheHits };
      unstableResults += general.failures;
    }
    // Recheck status under row lock: cancellation during scoring must not publish fresh matches.
    const [current] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id))
      .for("update");
    if (current?.status !== "published")
      throw new Error("Order closed during matching");
    // Подходящие люди закончились: отбор вернул меньше лимита (все потоки исчерпаны) или волна > 1 не нашла никого
    // нового по сравнению с прошлыми прогонами. Тогда следующих волн не будет; новый человек в городе снимает признак.
    const previousUsers = new Set((await db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT mt.user_id FROM matching_traces mt JOIN matching_runs mr ON mr.id=mt.matching_run_id
      WHERE mr.order_id=${order.id} AND mr.id<>${run.id} AND mr.completed_at IS NOT NULL`)).map((r) => r.user_id));
    const exhausted = generalExhausted && (shortlist.length < shortlistLimit || (wave > 1 && shortlist.every((c) => previousUsers.has(c.user_id))));
    await db.update(schema.orders)
      .set({ deliveryExhaustedAt: exhausted ? (current.deliveryExhaustedAt ?? new Date()) : null,
        deliveredWave: Math.max(current.deliveredWave ?? 0, wave) })
      .where(eq(schema.orders.id, order.id));
    await db
      .update(schema.matchingRuns)
      // A run with a failed review is published (fail-open) but never reused as a cache hit: the next
      // matching job for this order recomputes and retries the review instead of freezing the degraded result.
      .set({ completedAt: new Date(), candidatesCount, ...(reviewFailures > 0 || unstableResults > 0 || !pipelineProvable ? { inputHash: null } : {}) })
      .where(eq(schema.matchingRuns.id, run.id));
    console.log(JSON.stringify({ event: "matching_run_ai", orderId: order.id, matchingRunId: run.id, wave, reviewBudget: reviewLimit,
      aiReviews: reviews, reviewCacheHits, reviewFailures, ...generalStats }));
    return { orderId: order.id, matchingRunId: run.id, candidatesCount };
  });
}
