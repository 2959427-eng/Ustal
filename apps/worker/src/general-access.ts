import { AiConsentDenied } from "@ustal/ai";
import { consentPair } from "./worker-consent.js";
import { sql } from "drizzle-orm";
import { schema, type Database } from "@ustal/database";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import type { OrderAccess } from "@ustal/validation";
import { readCachedReview, reviewCacheKey, storeCachedReview, type ReviewCacheIdentity } from "./ai-review-cache.js";

/**
 * «Простые задачи» (2026-10-15): дополнительный путь показа (general access), не новый вердикт подбора.
 *
 * Заказ, классифицированный как general (средний взрослый без подготовки выполнит основной результат; нет явных
 * требований задачи), показывается исполнителям города, которые не получили его обычным подбором, если у них нет
 * отказа от такой работы и не нарушены их ограничения. Решение — о ЗАКАЗЕ: ничего не записывается в профиль, навыки
 * и связи онтологии не создаются, оценка навыков не повышается, демография/статус человека не используются.
 *
 * Кому НЕ показываем:
 *  - прежний подбор отклонил человека по явному основанию: отказ, время, «только …», место, ресурс, допуск;
 *  - у человека есть ограничение «только …» (сам сузил круг работ);
 *  - явный отказ/ограничение человека относится к этому заказу (узел/смысл — существующая логика; затем AI-проверка
 *    отказа, только для людей с отказами); сбой проверки — не показываем (другого основания показа нет);
 *  - бюджет проверок этого прогона исчерпан — следующий прогон (волна/изменение профиля) решит заново.
 * Порядок: кто уже получил этот заказ раньше; затем кто реже получал простые заказы за 7 дней; затем user_id.
 * Аудит: matching_candidates.match_type='opportunity' + breakdown, matching_traces.detail.general_access.
 */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const GENERAL_ACCESS_EXPLANATION = "Простая задача — опыт не нужен";
export const GENERAL_ACCESS_SCORE = 10;

/**
 * Явное основание против человека в прежнем подборе: отказ, время, нужный ресурс, конфликт из review по «только …»,
 * месту, отказу, ресурсу, числам или допуску. «Нет доказательств навыка» (в том числе main-result domain_mismatch и
 * отложенный review) основанием не является — это ровно случай general access.
 */
const HARD_REASONS = new Set(["explicit_exclusion", "outside_availability", "missing_mandatory_resource"]);
export function generalEligibleAfterMatching(reason: string, reviewConflictKind?: string | null): boolean {
  if (HARD_REASONS.has(reason)) return false;
  if (reason.endsWith("_mismatch")) return reason === "domain_mismatch";
  if (reason === "source_incompatibility") return !reviewConflictKind || reviewConflictKind === "domain";
  return true;
}

/** Заказ идёт по пути general access: уровень general и ни одного явного требования задачи. */
export function usesGeneralAccess(access: (OrderAccess & { version?: string }) | null | undefined): boolean {
  return access?.accessLevel === "general" && access.explicitRequirements.length === 0;
}

export interface GeneralFact {
  kind: string;
  phrase: string;
  evidence: string;
  constraintType?: string | null;
}
export interface PriorOutcome {
  /** reason прежнего подбора (или deferred_review_budget). */
  reason: string;
  reviewConflictKind?: string | null;
  profileId: string | null;
}
export interface GeneralAccessInput {
  orderId: string;
  runId: string;
  orderText: string;
  access: OrderAccess & { version?: string };
  cityId: string;
  authorId: string;
  /** Получили заказ обычным подбором в этом прогоне. */
  matched: Set<string>;
  /** Итог прежнего подбора для оценённых в этом прогоне. */
  evaluated: Map<string, PriorOutcome>;
  slots: number;
  /** Сколько AI-проверок отказа ещё можно сделать в этом прогоне. */
  reviewBudget: number;
  traceId: string;
  /** Прежняя (детерминированная) оценка ограничений человека: reason из evaluateSemantic по его фактам. */
  hardReason: (facts: (GeneralFact & Record<string, unknown>)[]) => string;
}
/** reviews = real AI refusal checks (budget); cacheHits = memoized verdicts reused without an AI call;
 * failures = technical refusal-check failures (the run must not be reused as a whole-run cache hit). */
export interface GeneralAccessResult { added: number; exhausted: boolean; reviews: number; cacheHits: number; failures: number }

export const REFUSAL_CHECK_PROMPT_VERSION = "refusal-target-v1";
type RefusalVerdict = { involves: boolean; reason: string };

/**
 * Whole-run validity (fix 2026-10-15): fingerprint of everything deliverGeneralAccess reads about people, for the
 * matching run inputHash. Covers the WHOLE eligible pool of the city, not just the ordinary shortlist: every active user
 * in the city except the author and blocked pairs, their latest applied capability profile, its latest matching document
 * and all facts of that document (restrictions, scope/availability limits, capabilities) — exactly the rows the delivery
 * reads. Adding/lifting a restriction, a new profile version, a status/city/block change of anyone in the pool changes
 * the hash, so a stale whole-run early return is impossible. Deliberately NOT included: the rotation order (how many
 * simple tasks people got for other orders in 7 days) — it only reorders equally eligible people.
 */
export async function generalAccessPoolFingerprint(db: Tx, input: { cityId: string; authorId: string }): Promise<string> {
  // Canonical structured serialization (fix 2026-10-15, re-acceptance FAIL 2): one jsonb object per person with
  // explicit field names and explicit null (jsonb_build_object keeps null keys; jsonb text has a stable key order),
  // facts as an unordered set sorted by their canonical text (DB/physical order and fact ids do not matter),
  // people sorted by user id; then SHA-256. No separator joining: NULL cannot disappear, positions cannot shift,
  // null / "" / [] stay distinct, and values containing separators cannot collide.
  const [row] = await db.execute<{ h: string }>(sql`
    SELECT encode(sha256(convert_to(coalesce(jsonb_agg(person ORDER BY person->>'user'), '[]'::jsonb)::text, 'UTF8')), 'hex') h FROM (
      SELECT jsonb_build_object('user', u.id, 'profile', cp.id, 'document', d.id, 'facts', coalesce((
        SELECT jsonb_agg(f ORDER BY f::text) FROM (
          SELECT jsonb_build_object('kind', mf.kind, 'phrase', mf.phrase, 'evidence', mf.evidence,
            'constraintType', mf.constraint_type, 'constraintScope', mf.constraint_scope, 'resourceRole', mf.resource_role,
            'nodeIds', mf.node_ids, 'startHour', mf.start_hour, 'endHour', mf.end_hour, 'daysOfWeek', mf.days_of_week,
            'confidence', mf.confidence, 'mandatory', mf.mandatory) f
          FROM matching_facts mf WHERE mf.document_id=d.id) facts), '[]'::jsonb)) person
      FROM user_profiles up JOIN users u ON u.id=up.user_id
      LEFT JOIN LATERAL (SELECT id FROM capability_profiles WHERE user_id=u.id AND status='applied' ORDER BY profile_version DESC LIMIT 1) cp ON true
      LEFT JOIN LATERAL (SELECT md.id FROM matching_documents md WHERE md.profile_id=cp.id ORDER BY md.created_at DESC LIMIT 1) d ON true
      WHERE up.city_id=${input.cityId} AND u.status='active' AND u.id<>${input.authorId}
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${input.authorId} AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=${input.authorId}))
    ) t`);
  return row?.h ?? "";
}

export async function deliverGeneralAccess(db: Tx, input: GeneralAccessInput): Promise<GeneralAccessResult> {
  if (input.slots <= 0) return { added: 0, exhausted: false, reviews: 0, cacheHits: 0, failures: 0 };
  const fetchLimit = input.slots * 3;
  const pool = await db.execute<{ user_id: string; profile_id: string | null }>(sql`
    SELECT u.id user_id, cp.id profile_id
    FROM user_profiles up JOIN users u ON u.id=up.user_id
    LEFT JOIN LATERAL (SELECT id FROM capability_profiles WHERE user_id=u.id AND status='applied' ORDER BY profile_version DESC LIMIT 1) cp ON true
    WHERE up.city_id=${input.cityId} AND u.status='active' AND u.id<>${input.authorId}
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${input.authorId} AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=${input.authorId}))
    ORDER BY
      -- уже получившие этот заказ простой задачей не теряют его в следующих прогонах/волнах
      (SELECT 0 FROM matching_candidates mc JOIN matching_runs mr ON mr.id=mc.matching_run_id
        WHERE mr.order_id=${input.orderId} AND mr.completed_at IS NOT NULL AND mc.user_id=u.id AND mc.match_type='opportunity' LIMIT 1) NULLS LAST,
      (SELECT count(DISTINCT mr.order_id) FROM matching_candidates mc JOIN matching_runs mr ON mr.id=mc.matching_run_id
        WHERE mc.user_id=u.id AND mc.match_type='opportunity' AND mr.order_id<>${input.orderId}
          AND mr.started_at > now() - interval '7 days') ASC,
      u.id
    LIMIT ${fetchLimit}`);
  const users = [...pool].filter((r) => !input.matched.has(r.user_id));
  const profileIds = users.map((u) => u.profile_id).filter((id): id is string => !!id);
  type FactRow = { profile_id: string; kind: string; phrase: string; evidence: string; constraint_type: string; constraint_scope: string;
    resource_role: string; node_ids: string[]; start_hour: number | null; end_hour: number | null; days_of_week: number[] | null;
    confidence: string; mandatory: boolean } & Record<string, unknown>;
  const factRows = profileIds.length ? await db.execute<FactRow>(sql`
    SELECT d.profile_id, mf.kind, mf.phrase, mf.evidence, mf.constraint_type, mf.constraint_scope, mf.resource_role, mf.node_ids,
      mf.start_hour, mf.end_hour, mf.days_of_week, mf.confidence, mf.mandatory
    FROM (SELECT DISTINCT ON (md.profile_id) md.id, md.profile_id FROM matching_documents md
          WHERE md.profile_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(profileIds)}::jsonb))
          ORDER BY md.profile_id, md.created_at DESC) d
    JOIN matching_facts mf ON mf.document_id=d.id`) : [];
  const factsOf = (profileId: string | null) => profileId ? [...factRows].filter((f) => f.profile_id === profileId).map((f) => ({
    kind: f.kind, phrase: f.phrase, evidence: f.evidence, constraintType: f.constraint_type,
    constraintScope: f.constraint_scope, resourceRole: f.resource_role, nodeIds: f.node_ids ?? [], startHour: f.start_hour, endHour: f.end_hour,
    daysOfWeek: f.days_of_week, confidence: Number(f.confidence), mandatory: f.mandatory, embedding: null,
  })) : [];

  let added = 0, reviews = 0, cacheHits = 0, failures = 0;
  for (const u of users) {
    if (added >= input.slots) break;
    const prior = input.evaluated.get(u.user_id);
    const facts = factsOf(u.profile_id);
    const refusals = facts.filter((f) => (f.kind === "exclude" || f.constraintType === "exclusion"));
    const verdicts: { refusal: string; involves: boolean | null; reason: string; cached?: true }[] = [];
    let refusedBy: string | null = null;
    if (prior && !generalEligibleAfterMatching(prior.reason, prior.reviewConflictKind)) refusedBy = `matching:${prior.reason}`;
    else if (facts.some((f) => f.constraintType === "scope")) refusedBy = "only_scope";
    else if (!prior && facts.length) {
      const reason = input.hardReason(facts);
      if (!generalEligibleAfterMatching(reason)) refusedBy = `restrictions:${reason}`;
    }
    if (!refusedBy && refusals.length) {
      // Variant B: verdicts already memoized for (restriction text, order text, prompt, model) are reused and do not
      // consume the budget; only the restrictions that still need a real AI call are counted against it.
      let budgetSkipped = false;
      const consentCheck = await consentPair(u.user_id, async () => {
      const checks = await Promise.all(refusals.map(async (r) => {
        const identity: ReviewCacheIdentity = { reviewType: "general_access_refusal_check", promptVersion: REFUSAL_CHECK_PROMPT_VERSION,
          schemaVersion: "v1", input: { refusal: r.evidence || r.phrase, order: [input.orderText] } };
        const key = reviewCacheKey(identity);
        return { r, identity, key, cached: await readCachedReview<RefusalVerdict>(key) };
      }));
      if (reviews + checks.filter((c) => !c.cached).length > input.reviewBudget) { budgetSkipped = true; return; } // не проверено — не показываем в этом прогоне
      for (const { r, identity, key, cached } of checks) {
        if (cached) {
          cacheHits++;
          verdicts.push({ refusal: r.phrase, involves: cached.involves, reason: cached.reason, cached: true });
          if (cached.involves) { refusedBy = `refusal:${r.phrase}`; break; }
          continue;
        }
        const meta = { operationType: "general_access_refusal_check", traceId: input.traceId, promptVersion: REFUSAL_CHECK_PROMPT_VERSION, schemaVersion: "v1" };
        const started = new Date();
        reviews++;
        try {
          const res = await getAiProviders().extraction.checkRefusal(identity.input as { refusal: string; order: string[] }, meta);
          await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { result: res }));
          // Only a successful check is memoized (a throw = technical failure, never stored); first stored verdict wins.
          const v = await storeCachedReview<RefusalVerdict>(key, identity, { involves: res.data.involves, reason: res.data.reason });
          verdicts.push({ refusal: r.phrase, involves: v.involves, reason: v.reason });
          if (v.involves) { refusedBy = `refusal:${r.phrase}`; break; }
        } catch (error) {
          if (error instanceof AiConsentDenied) throw error;
          await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { error: error instanceof Error ? error : new Error(String(error)) }));
          verdicts.push({ refusal: r.phrase, involves: null, reason: "check_failed" });
          refusedBy = "refusal_check_failed";
          failures++;
          break;
        }
      }
      });
      if (!consentCheck.allowed || budgetSkipped) continue;
    }
    const audit = { path: "general_access", accessLevel: input.access.accessLevel, accessVersion: input.access.version ?? null,
      accessReason: input.access.reason, refusalsChecked: verdicts, ...(refusedBy ? { refusedBy } : {}) };
    if (prior) {
      // Тот же человек уже оценён в этом прогоне: дополняем его trace, не дублируя строку.
      await db.execute(sql`UPDATE matching_traces SET detail = detail || ${JSON.stringify({ general_access: audit })}::jsonb
        WHERE matching_run_id=${input.runId} AND user_id=${u.user_id}`);
    } else {
      await db.insert(schema.matchingTraces).values({ matchingRunId: input.runId, userId: u.user_id,
        decision: refusedBy ? "general_access_refused" : "general_access",
        detail: { reason: refusedBy ? "general_access_refused" : "general_access", general_access: audit,
          profile_id: u.profile_id, profile_document_id: null, order_document_id: null } });
    }
    if (refusedBy) continue;
    await db.insert(schema.matchingCandidates).values({ matchingRunId: input.runId, userId: u.user_id, score: String(GENERAL_ACCESS_SCORE),
      matchType: "opportunity", explanation: GENERAL_ACCESS_EXPLANATION, breakdown: audit });
    added++;
  }
  return { added, exhausted: pool.length < fetchLimit, reviews, cacheHits, failures };
}
