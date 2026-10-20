import type postgres from "postgres";
import { getSql } from "./client.js";
import { disclosureHash } from "./consents.js";

// Dormant primitives, NOT dispatch authorization. Only trusted server-resolved IDs enter this API.
export const blockedWorkKinds = ["profile_transcribe", "profile_extract", "profile_facts", "profile_rebuild", "embedding_refresh", "order_transcribe", "order_extract", "matching_run"] as const;
export type BlockedWorkInput = { kind: typeof blockedWorkKinds[number]; sourceId: string; executionId: string; sourceVersionHash: string;
  subjectUserIds: readonly string[]; purpose: string; policyId: string; policyHash: string; recipientBinding: string };
type Executor = postgres.Sql | postgres.TransactionSql;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export function blockedWorkIntent(input: BlockedWorkInput) {
  if (!blockedWorkKinds.includes(input.kind) || !uuid.test(input.sourceId) || !uuid.test(input.executionId) || !uuid.test(input.policyId) ||
      !hash.test(input.sourceVersionHash) || !hash.test(input.policyHash) || !hash.test(input.recipientBinding) ||
      !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(input.purpose) || !Array.isArray(input.subjectUserIds) ||
      !input.subjectUserIds.length || input.subjectUserIds.length > 100 || input.subjectUserIds.some(id => !uuid.test(id)))
    throw new Error("Invalid blocked work intent");
  const intent = { kind: input.kind, sourceId: input.sourceId.toLowerCase(), executionId: input.executionId.toLowerCase(), sourceVersionHash: input.sourceVersionHash,
    subjectUserIds: [...new Set(input.subjectUserIds.map(id => id.toLowerCase()))].sort(), purpose: input.purpose,
    policyId: input.policyId.toLowerCase(), policyHash: input.policyHash, recipientBinding: input.recipientBinding };
  return { ...intent, logicalKey: disclosureHash(intent) };
}
export function policyProbeDelaySeconds(attempts: number) {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("Invalid probe attempts");
  return Math.min(900, 5 * 2 ** Math.min(attempts, 8));
}
/** Idempotent per execution; resumed jobs MUST use their new stable execution/job UUID. Existing leases/finished executions are never reset. */
export async function pauseConsentWork(input: BlockedWorkInput, reason: "consent_required" | "policy_unavailable", sql: Executor = getSql()) {
  if (!["consent_required", "policy_unavailable"].includes(reason)) throw new Error("Invalid pause reason");
  const i = blockedWorkIntent(input);
  // jsonb expansion works even on the first postgres.js connection, before array OID discovery.
  const rows = await sql`INSERT INTO ai_consent_blocked_work(logical_key,kind,source_id,execution_id,source_version_hash,subject_user_ids,purpose,policy_id,policy_hash,recipient_binding,reason,state,next_probe_at)
    VALUES(${i.logicalKey},${i.kind},${i.sourceId},${i.executionId},${i.sourceVersionHash},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(i.subjectUserIds)}::text::jsonb)::uuid),${i.purpose},${i.policyId},${i.policyHash},${i.recipientBinding},${reason},
      'ready',CASE WHEN ${reason}='policy_unavailable' THEN clock_timestamp()+interval '5 seconds' ELSE clock_timestamp() END)
    ON CONFLICT(logical_key) DO NOTHING RETURNING id`;
  if (rows[0]) return { id: rows[0].id as string, inserted: true };
  // Canonical second statement sees a concurrently committed winner under READ COMMITTED.
  const [row] = await sql`SELECT id FROM ai_consent_blocked_work WHERE logical_key=${i.logicalKey}`;
  return { id: (row?.id ?? null) as string | null, inserted: false };
}
export type BlockedWorkClaim = { id: string; lease_token: string; wake_seq: number; source_id: string; execution_id: string; source_version_hash: string;
  subject_user_ids: string[]; kind: string; purpose: string; policy_id: string; policy_hash: string; recipient_binding: string; attempts: number };
/** One short statement, no user locks/HTTP. Lease is bounded to 5–120 seconds. */
export async function claimConsentWork(limit = 10, leaseSeconds = 30, sql: Executor = getSql(), purpose: string | null = null): Promise<BlockedWorkClaim[]> {
  if (purpose !== null && !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(purpose)) throw new Error("Invalid claim purpose");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 120)
    throw new Error("Invalid claim bounds");
  return await sql`WITH due AS (SELECT id FROM ai_consent_blocked_work
    WHERE ((state='ready' AND next_probe_at <= clock_timestamp()) OR (state='leased' AND lease_until <= clock_timestamp()))
      AND (${purpose}::text IS NULL OR purpose=${purpose})
    ORDER BY created_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    UPDATE ai_consent_blocked_work w SET state='leased',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+${leaseSeconds}*interval '1 second'
    FROM due WHERE w.id=due.id RETURNING w.*` as unknown as BlockedWorkClaim[];
}
/** Signals readiness only, NEVER consent. May run inside the SAME grant/publication transaction. */
export async function wakeConsentWork(subjectId: string, purpose: string, sql: Executor = getSql()) {
  if (!uuid.test(subjectId) || !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(purpose)) throw new Error("Invalid wake signal");
  return (await sql`UPDATE ai_consent_blocked_work SET wake_seq=wake_seq+1,
    state=CASE WHEN state='leased' THEN state ELSE 'ready' END,
    next_probe_at=clock_timestamp() WHERE subject_user_ids @> ARRAY[${subjectId}::uuid] AND purpose=${purpose} AND state IN ('waiting','ready','leased') RETURNING id`).length;
}
/** Token AND unexpired lease fence every ack. A wake during authorization cannot be lost by a later wait ack. */
export async function acknowledgeConsentWork(claim: Pick<BlockedWorkClaim, "id" | "lease_token" | "wake_seq">,
  outcome: "enqueued" | "obsolete" | "consent_required" | "policy_unavailable", sql: Executor = getSql()) {
  if (!uuid.test(claim.id) || !uuid.test(claim.lease_token) || !Number.isSafeInteger(claim.wake_seq) || claim.wake_seq < 0 ||
      !["enqueued", "obsolete", "consent_required", "policy_unavailable"].includes(outcome)) throw new Error("Invalid work acknowledgement");
  const rows = await sql`UPDATE ai_consent_blocked_work SET
    state=CASE WHEN ${outcome} IN ('enqueued','obsolete') THEN ${outcome}
      WHEN wake_seq<>${claim.wake_seq} OR ${outcome}='policy_unavailable' THEN 'ready' ELSE 'waiting' END,
    reason=CASE WHEN ${outcome} IN ('consent_required','policy_unavailable') THEN ${outcome} ELSE reason END,
    attempts=CASE WHEN ${outcome}='policy_unavailable' THEN least(attempts+1,1000000) ELSE attempts END,
    next_probe_at=CASE WHEN ${outcome} IN ('enqueued','obsolete') THEN NULL
      WHEN wake_seq<>${claim.wake_seq} THEN clock_timestamp()
      WHEN ${outcome}='policy_unavailable' THEN clock_timestamp()+least(900,5*power(2,least(attempts+1,8)))*interval '1 second' ELSE NULL END,
    lease_token=NULL,lease_until=NULL
    WHERE id=${claim.id} AND state='leased' AND lease_token=${claim.lease_token} AND lease_until>clock_timestamp() RETURNING id`;
  return rows.length === 1;
}
/** Trusted source reconciliation, not extraction replay. Current version remains untouched. */
export async function obsoleteConsentWork(kind: BlockedWorkInput["kind"], sourceId: string, currentVersionHash: string | null, sql: Executor = getSql()) {
  if (!blockedWorkKinds.includes(kind) || !uuid.test(sourceId) || (currentVersionHash !== null && !hash.test(currentVersionHash))) throw new Error("Invalid obsolete source");
  return (await sql`UPDATE ai_consent_blocked_work SET state='obsolete',lease_token=NULL,lease_until=NULL,next_probe_at=NULL
    WHERE kind=${kind} AND source_id=${sourceId} AND (${currentVersionHash}::text IS NULL OR source_version_hash<>${currentVersionHash})
    AND state IN ('waiting','ready','leased') RETURNING id`).length;
}
