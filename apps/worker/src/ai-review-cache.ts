import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { reviewPipelineFingerprint } from "@ustal/ai";

/**
 * Variant B (2026-10-15): memoization of already executed AI review decisions between runs/waves.
 *
 * Content-addressed: the key is sha256 over the canonical JSON of
 *   { cacheVersion, reviewType, pipeline, promptVersion, schemaVersion, input }
 * where `pipeline` is reviewPipelineFingerprint(reviewType) from @ustal/ai — an automatic hash of the real review
 * pipeline (every prompt incl. nested verifiers, schemas, validation/post-processing source, SDK versions, provider,
 * endpoint, models, request parameters) — and `input` is EXACTLY the object passed to the AI provider. Any change of
 * profile/order/restriction text or of anything in the pipeline gives a new key; old rows are simply never read again
 * (no manual invalidation, no reliance on manual version bumps). user_id/order_id are not part of the key.
 * No provable fingerprint (null) -> no key -> the cache is neither read nor written.
 *
 * Only successful, non-degraded verdicts are stored. A technical failure (throw/timeout/invalid output)
 * or a verdict whose secondary verification failed (`degraded`) is never written, so the next run retries.
 *
 * Reads/writes go through the shared pool in autocommit, NOT the matching transaction: a stored verdict
 * survives a rolled-back/expired run, and the unique index is never held locked for a whole run.
 * Concurrent identical writes: INSERT ... ON CONFLICT DO NOTHING, then the stored row wins for everyone.
 */
export const REVIEW_CACHE_VERSION = "review-cache-v2";

export interface ReviewCacheIdentity {
  reviewType: "semantic_pair_review" | "general_access_refusal_check";
  promptVersion: string;
  schemaVersion: string;
  input: unknown;
}

/** Provider + model, stored for diagnostics only (the key uses the full pipeline fingerprint). */
export function reviewCacheModel(): string {
  const env = loadEnv();
  return `${env.AI_PROVIDER}:${env.AI_MODEL_SEMANTIC_REVIEW}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function reviewCacheKey(identity: ReviewCacheIdentity, pipeline = reviewPipelineFingerprint(identity.reviewType)): string | null {
  if (!pipeline) return null;
  return createHash("sha256").update(canonical({
    cacheVersion: REVIEW_CACHE_VERSION, reviewType: identity.reviewType, pipeline,
    promptVersion: identity.promptVersion, schemaVersion: identity.schemaVersion, input: identity.input,
  })).digest("hex");
}

/** A cache read error is a miss (the review simply runs), never a run failure. */
export async function readCachedReview<T>(key: string | null): Promise<T | null> {
  if (!key) return null;
  try {
    const [row] = await getDb().select({ result: schema.aiReviewCache.result })
      .from(schema.aiReviewCache).where(eq(schema.aiReviewCache.cacheKey, key)).limit(1);
    return row ? (row.result as T) : null;
  } catch (error) {
    console.error(JSON.stringify({ event: "ai_review_cache_read_failed", error: error instanceof Error ? error.name : "unknown" }));
    return null;
  }
}

/** Stores a successful verdict; returns the verdict that is in the cache afterwards (first writer wins). */
export async function storeCachedReview<T>(key: string | null, identity: ReviewCacheIdentity, result: T, model = reviewCacheModel()): Promise<T> {
  if (!key) return result;
  try {
    const inserted = await getDb().insert(schema.aiReviewCache)
      .values({ cacheKey: key, reviewType: identity.reviewType, model, promptVersion: identity.promptVersion, result: result as never })
      .onConflictDoNothing({ target: schema.aiReviewCache.cacheKey })
      .returning({ result: schema.aiReviewCache.result });
    if (inserted[0]) return inserted[0].result as T;
  } catch (error) {
    // Not stored: the fresh verdict is still used for this run; the next run just calls AI again.
    console.error(JSON.stringify({ event: "ai_review_cache_write_failed", error: error instanceof Error ? error.name : "unknown" }));
    return result;
  }
  return (await readCachedReview<T>(key)) ?? result;
}
