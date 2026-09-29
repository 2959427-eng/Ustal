/**
 * Stage-0 career-context probe (claude/extended-ai-profile-architecture-2026-09-27.md).
 * Runs the REAL production functions with live AI (same .env provider/models):
 *   extractCapabilityProfile -> capabilityExtractionResultSchema -> prepareDocument(normalizeMatching,
 *   ontology mapping, negatives, embeddings) -> [cumulative: planNegativeOverrides + carry-forward of facts]
 *   extractOrder -> orderExtractionResultSchema -> prepareDocument("order")
 *   evaluateSemantic -> shouldRunSourceReview -> reviewSemantic -> evaluateSemantic (matching-run.ts glue, copied verbatim).
 * Only Postgres is replaced: ontology comes from the unchanged seed (packages/database/src/seed.ts), retrieval
 * is computed in memory (canonical node hit + document cosine). No DB writes, no repo code changes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getAiProviders, moderateWithRules } from "@ustal/ai";
import { schema } from "@ustal/database";
import { ONTOLOGY_NODES } from "../packages/database/src/ontology-data.js";
import { capabilityExtractionResultSchema, orderExtractionResultSchema } from "@ustal/validation";
import { cosine, evaluateSemantic } from "@ustal/matching";
import { prepareDocument, type PreparedDocument } from "../apps/worker/src/semantic.js";
import { planNegativeOverrides, isUserAssetResource } from "../apps/worker/src/profile-negatives.js";
import { shouldRunSourceReview, runSourceReview, decideAfterReview } from "../apps/worker/src/handlers/matching-run.js";

const uid = (s: string) => { const h = createHash("sha1").update(s).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const idByKey = new Map(ONTOLOGY_NODES.map((n) => [n.canonicalKey, uid(n.canonicalKey)]));
const nodes = ONTOLOGY_NODES.map((n) => ({ id: idByKey.get(n.canonicalKey)!, canonicalKey: n.canonicalKey, nameRu: n.nameRu, description: null,
  nodeType: n.nodeType, parentId: n.parentKey ? idByKey.get(n.parentKey) ?? null : null, riskLevel: n.riskLevel ?? 0, regulated: n.regulated ?? false,
  requiresVerification: n.requiresVerification ?? false, status: "active", version: 1 }));
const synonyms = ONTOLOGY_NODES.flatMap((n) => (n.synonyms ?? []).map((p) => ({ id: uid(n.canonicalKey + "::" + p), ontologyNodeId: idByKey.get(n.canonicalKey)!, phraseRu: p })));
const seedEdges: [string, string][] = [["loading","unloading"],["unloading","loading"],["manual_carrying","loading"],["loading","manual_carrying"],["moving_help","manual_carrying"],["moving_help","loading"],["loading","moving_help"]];
const relations = seedEdges.map(([f, t]) => ({ id: uid(f+t), fromNodeId: idByKey.get(f)!, toNodeId: idByKey.get(t)!, relationType: "related" }));
for (const n of nodes) if (n.parentId) relations.push({ id: `parent:${n.id}`, fromNodeId: n.id, toNodeId: n.parentId, relationType: "is_a" });
const keyById = new Map(nodes.map((n) => [n.id, n.canonicalKey]));

const rowsFor = (t: unknown) => (t === schema.ontologyNodes ? nodes : t === schema.ontologySynonyms ? synonyms : []);
(globalThis as any).__fakeDb = {
  select: () => ({ from: (t: unknown) => Object.assign(Promise.resolve(rowsFor(t)), { where: () => Promise.resolve(rowsFor(t)) }) }),
  insert: () => ({ values: async () => undefined }),
};

const ai = getAiProviders();
const meta = (op: string) => ({ operationType: op, traceId: "stage0", promptVersion: "v1", schemaVersion: "v1" });
async function retry<T>(f: () => Promise<T>, n = 10, otherErrors = 2): Promise<T> { let e: unknown; for (let i = 0; i < n; i++) { try { return await f(); } catch (x) { e = x; const rl = /429|Rate limit/.test(String(x)); if (!rl && i >= otherErrors) break; await new Promise((r) => setTimeout(r, rl ? 4000 + Math.random() * 8000 : 500)); } } throw e; }

export interface ProfileDoc { label: string; doc: PreparedDocument; summary: string; capNodes: string[]; resNodes: string[] }
export async function buildProfile(label: string, text: string, prior?: ProfileDoc): Promise<ProfileDoc> {
  return retry(async () => {
    const ex = await ai.extraction.extractCapabilityProfile({ text, previousProfileSummary: prior?.summary }, meta("profile_extraction"));
    const extracted = capabilityExtractionResultSchema.parse(ex.data);
    const source = prior ? [prior.doc.sourceText, text].join("\nПоследнее изменение пользователя:\n") : text;
    const doc = await prepareDocument("profile", source, extracted, "stage0");
    if (prior) {
      // profile-extraction.ts + profile-merge.ts facts part: carry prior capability/resource facts whose nodes vanished and were not excluded.
      const ov = planNegativeOverrides(doc.facts, prior.doc.facts);
      const cur = new Set(doc.facts.flatMap((f) => (f.kind === "capability" || isUserAssetResource(f)) ? f.nodeIds : []));
      const carried = new Set([...prior.capNodes, ...prior.resNodes].filter((id) => !cur.has(id) && !ov.excludedNodeIds.has(id)));
      for (const f of prior.doc.facts) if ((f.kind === "capability" || f.kind === "resource") && f.nodeIds.length && f.nodeIds.every((i) => carried.has(i))) doc.facts.push(f);
    }
    const capNodes = [...new Set(doc.facts.filter((f) => f.kind === "capability").flatMap((f) => f.nodeIds))];
    const resNodes = [...new Set(doc.facts.filter((f) => isUserAssetResource(f)).flatMap((f) => f.nodeIds))];
    return { label, doc, summary: extracted.summary, capNodes, resNodes };
  });
}
export interface OrderDoc { id: string; doc: PreparedDocument; riskLevel: number; regulated: boolean; requiresQualification: boolean; moderation?: string }
export async function buildOrder(id: string, text: string): Promise<OrderDoc> {
  return retry(async () => {
    const ex = await ai.extraction.extractOrder({ text }, meta("order_extraction"));
    const extracted = orderExtractionResultSchema.parse(ex.data);
    const doc = await prepareDocument("order", text, extracted, "stage0");
    const riskLevel = extracted.requiresQualification ? 1 : 0;
    // order-extraction.ts moderation: rules first, AI otherwise; manual_review/reject never publish.
    const rule = moderateWithRules(text);
    const moderation = rule.decision ?? (await ai.moderation.moderate({ text, riskLevel }, meta("order_moderation"))).data.decision;
    return { id, doc, riskLevel, regulated: extracted.regulated, requiresQualification: extracted.requiresQualification, moderation };
  });
}

export async function match(p: ProfileDoc, o: OrderDoc) {
  const requirements = o.doc.facts.map((f) => ({ ...f, confidence: Number(f.confidence) }));
  const requiredIds = requirements.flatMap((r) => r.nodeIds);
  const retrievalIds = new Set([...requiredIds, ...relations.filter((r) => requiredIds.includes(r.toNodeId)).map((r) => r.fromNodeId)]);
  const canonicalHit = [...p.capNodes, ...p.resNodes].some((id) => retrievalIds.has(id));
  const facts = p.doc.facts.map((f) => ({ ...f, confidence: Number(f.confidence) }));
  // ---- verbatim glue from apps/worker/src/handlers/matching-run.ts ----
  const evaluation = {
    capabilities: facts as any, requirements: requirements as any, relations,
    documentSimilarity: cosine(p.doc.embedding, o.doc.embedding), riskLevel: o.riskLevel, localWeekday: undefined,
    regulated: o.regulated || nodes.some((n) => n.regulated && requiredIds.includes(n.id)), localHour: undefined,
    negativePreference: false, reviewRequired: o.riskLevel > 0 || o.requiresQualification,
  };
  const pre = evaluateSemantic(evaluation);
  let result = pre;
  const needsSourceReview = ["insufficient_capability_evidence", "physical_compatibility_unverified", "safety_review_required"].includes(result.reason) ||
    Boolean(result.matchType && p.doc.sourceText && o.doc.sourceText);
  const structuredEvidence = facts.some((f) => (f.kind === "capability" && f.confidence >= 0.5) || (f.kind === "resource" && f.resourceRole === "available")) &&
    requirements.some((f) => f.kind === "capability" || f.kind === "resource");
  let review: any = null; let reviewFailed: any = null;
  if (shouldRunSourceReview({ needsSourceReview, structuredEvidence, sourceTextsAvailable: Boolean(p.doc.sourceText && o.doc.sourceText) })) {
    // handlers/matching-run.ts: runSourceReview never throws; decideAfterReview applies fail-open on technical failure.
    const outcome = await runSourceReview(() => retry(() => ai.extraction.reviewSemantic({ profile: [p.doc.sourceText], order: [o.doc.sourceText] }, meta("semantic_pair_review")), 10, 0), { orderId: o.id, userId: p.label });
    if (outcome.status === "ok") review = outcome.result.data; else reviewFailed = outcome.error;
    result = decideAfterReview(evaluation, outcome);
  }
  // ----------------------------------------------------------------------
  return { decision: result.matchType ? "MATCH" : "REJECT", classification: result.classification, reason: result.reason,
    preReview: pre.classification + "/" + pre.reason, canonicalHit, docSim: +evaluation.documentSimilarity.toFixed(3),
    reviewFailed, review: review && { compatible: review.compatible, confidence: review.confidence, hardConflict: review.hardConflict ?? null,
      exclusiveScope: review.exclusiveScope ?? null, reason: review.reason } };
}
export const factView = (d: PreparedDocument) => d.facts.map((f) => `${f.kind}${f.constraintType !== "none" ? "/" + f.constraintType + ":" + f.constraintScope : ""}${f.resourceRole !== "none" ? "/" + f.resourceRole : ""} «${f.phrase}» [${f.nodeIds.map((i) => keyById.get(i) ?? "?").join(",")}] c=${f.confidence}${f.subjectType && f.subjectType !== "unspecified" ? " st=" + f.subjectType : ""}${f.kind==="resource" ? " cap=" + JSON.stringify(f.resourceCapacity) + " scope=" + f.constraintScope + " mand=" + f.mandatory : ""}`);


export async function pool<T>(items: (() => Promise<T>)[], n = 4) { const out: T[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await items[k]!(); } })); return out; }
