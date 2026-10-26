import { wakeConsentWork } from "./consent-blocked-work.js";
import { createHash } from "node:crypto";
import { getSql } from "./client.js";
import { canonicalRecipientEndpoint } from "@ustal/config";
import postgres from "postgres";
import { loadDatabaseUrl } from "./env.js";

// Registry evidence never implies approval by itself; explicit dispatch enforcement uses the shared batch authorizer.
export function disclosureHash(content: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    throw new Error("Disclosure must contain JSON values only");
  };
  return createHash("sha256").update(canonical(content), "utf8").digest("hex");
}

export class ConsentError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type ConsentDecision = {
  policyId: string; policyHash: string; decision: "grant" | "revoke"; expectedRevision: number;
  /** Версия и дословный текст уведомления, показанные пользователю (клиенты с 2026-10-26). */
  policyVersion?: string; notice?: string[];
};

/** Утверждённое краткое уведомление политики (content.notice: абзацы, показанные в окне согласия). */
export function policyNotice(content: unknown): string[] | null {
  const notice = content && typeof content === "object" ? (content as { notice?: unknown }).notice : undefined;
  return Array.isArray(notice) && notice.length > 0 && notice.every(p => typeof p === "string" && p.trim() !== "") ? notice as string[] : null;
}
const sameNotice = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

export async function readConsents(userId: string) {
  return getSql().begin(async tx => {
    // Serialize with deletion so an authenticated request cannot read evidence after delete commits.
    const [user] = await tx`SELECT status FROM users WHERE id=${userId} FOR SHARE`;
    if (user?.status !== "active") throw new ConsentError(401, "unauthorized");
    const [revision] = await tx`SELECT coalesce(max(seq), 0)::integer AS revision FROM consent_decisions WHERE user_id=${userId}`;
    const policies = await tx`SELECT id, purpose, version, content, content_hash AS "policyHash", status FROM consent_disclosures WHERE is_current ORDER BY purpose`;
    const decisions = await tx`SELECT DISTINCT ON (p.purpose) p.purpose, d.policy_id AS "policyId", d.policy_hash AS "policyHash",
      d.decision, d.seq, d.actor_user_id AS "actorUserId", d.decided_at AS "decidedAt",
      (d.decision='grant' AND p.status='approved' AND p.is_current) AS effective
      FROM consent_decisions d JOIN consent_disclosures p ON p.id=d.policy_id
      WHERE d.user_id=${userId} ORDER BY p.purpose, d.seq DESC`;
    return { revision: revision!.revision as number, policies, decisions, outboundEnforcement: false };
  });
}

export async function decideConsent(userId: string, input: ConsentDecision) {
  return getSql().begin(async tx => {
    // Same lock deletion uses; no grant can commit after deleted-user transition.
    const [user] = await tx`SELECT status FROM users WHERE id=${userId} FOR UPDATE`;
    if (user?.status !== "active") throw new ConsentError(401, "unauthorized");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId},17))`;
    const [revision] = await tx`SELECT coalesce(max(seq), 0)::integer AS revision FROM consent_decisions WHERE user_id=${userId}`;
    const currentRevision = revision!.revision as number;
    if (input.expectedRevision !== currentRevision) throw new ConsentError(409, "consent_revision_conflict");
    const [policy] = await tx`SELECT * FROM consent_disclosures WHERE id=${input.policyId} FOR SHARE`;
    if (!policy || policy.content_hash !== input.policyHash || disclosureHash(policy.content) !== input.policyHash)
      throw new ConsentError(409, "consent_policy_changed");
    if (input.policyVersion !== undefined && input.policyVersion !== policy.version)
      throw new ConsentError(409, "consent_policy_changed");
    if (input.decision === "grant" && (policy.status !== "approved" || !policy.is_current))
      throw new ConsentError(409, "consent_policy_not_approved_current");
    // Grant привязан к показанному тексту: политика с утверждённым уведомлением принимает согласие только при
    // дословном совпадении текста и версии; присланный текст без уведомления в политике — тоже отказ (fail-closed).
    const notice = policyNotice(policy.content);
    if (input.decision === "grant" && (notice || input.notice) &&
      (!notice || !input.notice || input.policyVersion !== policy.version || !sameNotice(notice, input.notice)))
      throw new ConsentError(409, "consent_notice_mismatch");
    const [latest] = await tx`SELECT d.* FROM consent_decisions d JOIN consent_disclosures p ON p.id=d.policy_id
      WHERE d.user_id=${userId} AND p.purpose=${policy.purpose} ORDER BY d.seq DESC LIMIT 1`;
    if (latest?.decision === input.decision && latest.policy_id === input.policyId && latest.policy_hash === input.policyHash)
      return { changed: false, revision: currentRevision };
    const next = currentRevision + 1;
    await tx`INSERT INTO consent_decisions (user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${userId}, ${userId}, ${next}, ${input.policyId}, ${input.policyHash}, ${input.decision})`;
    if (input.decision === "grant") {
      const [table] = await tx`SELECT to_regclass('ai_consent_blocked_work') IS NOT NULL AS present`;
      if (table?.present) await wakeConsentWork(userId, policy.purpose as string, tx);
    }
    return { changed: true, revision: next };
  });
}

export interface PublishedAiDisclosure {
  approved: true; policyId: string; policyHash: string; purpose: string;
  provider: string; endpoint: string; recipientBinding: string;
}
export interface ActualRecipientConfiguration { provider: string; endpoint: string; recipientBinding: string }
export interface BatchAuthorizationInput {
  subjectUserIds: readonly string[]; publication: Readonly<PublishedAiDisclosure>; operation: string; traceId: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finalText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 &&
  !/(?:^|[^a-z0-9])(?:TBD|TODO|PLACEHOLDER|DRAFT)(?=$|[^a-z0-9])|ЧЕРНОВИК|\[USTAL_/i.test(value);
function bindingMatches(actual: ActualRecipientConfiguration, other: Record<string, unknown>): boolean {
  try { return other.provider === actual.provider && other.recipientBinding === actual.recipientBinding &&
    typeof other.endpoint === "string" && canonicalRecipientEndpoint(other.endpoint) === canonicalRecipientEndpoint(actual.endpoint); }
  catch { return false; }
}

export class ConsentAuthorizationUnavailable extends Error {
  readonly name = "ConsentAuthorizationUnavailable";
  constructor() { super("Consent authorization unavailable"); }
}
let authorizationPool: ReturnType<typeof postgres> | undefined;
let authorizationInFlight = 0;
/** Separate from the long-lived matching pool. Two admissions, no waiting queue, bounded DB/transport time. */
function getAuthorizationSql() {
  return authorizationPool ??= postgres(loadDatabaseUrl(), { max: 2, connect_timeout: 2, idle_timeout: 15,
    max_lifetime: 300, debug: false, connection: { application_name: "ustal-consent-authorizer", statement_timeout: 2000 } });
}
/** Future worker shutdown MUST call this; this dormant scope does not integrate process lifecycle. */
export async function closeConsentAuthorizationPool(): Promise<void> {
  const pool = authorizationPool; authorizationPool = undefined;
  if (pool) await pool.end({ timeout: 1 });
}

async function readAuthorizationSnapshot(ids: string[], p: PublishedAiDisclosure) {
  if (authorizationInFlight >= 2) throw new ConsentAuthorizationUnavailable();
  authorizationInFlight++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let query: postgres.PendingQuery<postgres.Row[]> | undefined;
  try {
    const sql = getAuthorizationSql();
    query = sql`/* consent_authorization_snapshot_v1 */
      WITH publication AS (
        SELECT id,purpose,content,content_hash,status,is_current FROM consent_disclosures WHERE id=${p.policyId}::uuid
      )
      SELECT subjects.user_id,u.status AS user_status,pub.id AS publication_id,pub.purpose,pub.content,pub.content_hash,
        pub.status AS publication_status,pub.is_current,latest.policy_id,latest.policy_hash,latest.decision,
        revision.current_revision
      -- Bind one JSON scalar: sql.array() on a brand-new postgres.js client can infer scalar text
      -- before its array OID map is ready, producing 22P02 on the first permission check.
      FROM (SELECT value::uuid AS user_id FROM jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)) subjects
      LEFT JOIN users u ON u.id=subjects.user_id
      LEFT JOIN publication pub ON true
      LEFT JOIN LATERAL (
        SELECT d.policy_id,d.policy_hash,d.decision FROM consent_decisions d
        JOIN consent_disclosures prior ON prior.id=d.policy_id
        WHERE d.user_id=subjects.user_id AND prior.purpose=${p.purpose} ORDER BY d.seq DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(max(seq),0)::integer AS current_revision FROM consent_decisions WHERE user_id=subjects.user_id
      ) revision ON true`;
    return await Promise.race([query, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { query?.cancel(); reject(new ConsentAuthorizationUnavailable()); }, 3000);
    })]);
  } catch { throw new ConsentAuthorizationUnavailable(); } // Never retain URL, SQL parameters or raw DB errors.
  finally { if (timer) clearTimeout(timer); authorizationInFlight--; }
}

/** Publication and permission are read together in ONE fresh dedicated-pool statement, never an ambient run transaction.
 * `actual` MUST come from server-owned SDK configuration, not request or publication values.
 * No positive permission cache, no real approved content, no runtime activation in this scope. */
export function createConsentBatchAuthorizer(actual: Readonly<ActualRecipientConfiguration>, observe?: (snapshot: { publication: Readonly<PublishedAiDisclosure>; revisions: ReadonlyArray<{ userId: string; revision: number }> }) => void) {
  const fixedActual = Object.freeze({ ...actual });
  return async (input: BatchAuthorizationInput): Promise<boolean> => {
    const p = input.publication;
    if (!p || p.approved !== true || !uuid.test(p.policyId) || !digest.test(p.policyHash) || !finalText(p.purpose) ||
        !finalText(fixedActual.provider) || !digest.test(fixedActual.recipientBinding) || !bindingMatches(fixedActual, { ...p }) ||
        !Array.isArray(input.subjectUserIds) || !input.subjectUserIds.length || input.subjectUserIds.length > 100 ||
        input.subjectUserIds.some(id => typeof id !== "string" || !uuid.test(id))) return false;
    const ids = [...new Set(input.subjectUserIds.map(id => id.toLowerCase()))].sort();
    const rows = await readAuthorizationSnapshot(ids, p);
    if (rows.length !== ids.length || !rows.every(row => row.user_status === "active" && row.publication_status === "approved" &&
        row.is_current === true && row.publication_id === p.policyId.toLowerCase() && row.purpose === p.purpose && row.content_hash === p.policyHash &&
        row.decision === "grant" && row.policy_id === p.policyId.toLowerCase() && row.policy_hash === p.policyHash)) return false;
    const content: unknown = rows[0]!.content;
    if (!record(content) || !finalText(content.humanText) || disclosureHash(content) !== p.policyHash || !record(content.aiDispatch)) return false;
    const dispatch = content.aiDispatch;
    if (dispatch.schemaVersion !== 1 || dispatch.purpose !== p.purpose || !Array.isArray(dispatch.recipients) ||
        !dispatch.recipients.length || dispatch.recipients.length > 100) return false;
    if (!dispatch.recipients.every(r => {
      if (!record(r) || !finalText(r.name) || !finalText(r.provider) || typeof r.endpoint !== "string" ||
          typeof r.recipientBinding !== "string" || !digest.test(r.recipientBinding)) return false;
      try { canonicalRecipientEndpoint(r.endpoint); return true; } catch { return false; }
    })) return false;
    if (dispatch.recipients.filter(r => bindingMatches(fixedActual, r)).length !== 1) return false;
    observe?.({ publication: p, revisions: rows.map(row => ({ userId: row.user_id as string, revision: row.current_revision as number })) });
    return true;
  };
}

/** Same bounded admission pool as authorization; never queue behind long matching transactions. */
export async function readCurrentConsentPublication(purpose: string) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(purpose)) throw new ConsentAuthorizationUnavailable();
  if (authorizationInFlight >= 2) throw new ConsentAuthorizationUnavailable();
  authorizationInFlight++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sql = getAuthorizationSql();
    const pending = sql`SELECT id,content_hash,purpose FROM consent_disclosures WHERE purpose=${purpose} AND status='approved' AND is_current`;
    const rows = await Promise.race([pending, new Promise<never>((_resolve,reject) => {
      timer=setTimeout(()=>{pending.cancel();reject(new ConsentAuthorizationUnavailable());},3000);
    })]);
    return rows[0] as { id: string; content_hash: string; purpose: string } | undefined;
  } catch { throw new ConsentAuthorizationUnavailable(); }
  finally { if (timer) clearTimeout(timer); authorizationInFlight--; }
}
