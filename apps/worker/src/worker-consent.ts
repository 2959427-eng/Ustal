import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql as query } from "drizzle-orm";
import { AiConsentDenied, assertAiConsentDispatch, configureConsentDispatch, currentOpenAiRecipientConfiguration, withAiConsentContext, type ConsentPublication } from "@ustal/ai";
import { getSql, readCurrentConsentPublication, disclosureHash, createConsentBatchAuthorizer, pauseConsentWork, claimConsentWork, acknowledgeConsentWork, type BlockedWorkInput } from "@ustal/database";

type Kind = BlockedWorkInput["kind"];
type Job = { id: string; data: { userId?: string; sourceInputId?: string; orderId?: string } };
type Epoch = { userId: string; revision: number; publication: ConsentPublication; intent: BlockedWorkInput };
type State = { pending: { state: State; error: AiConsentDenied }[]; intent: BlockedWorkInput; epochs: Map<string, Epoch>; blocked: number; parent?: State };
const storage = new AsyncLocalStorage<State>();
let runtime: { purpose: string; actual: Awaited<ReturnType<typeof currentOpenAiRecipientConfiguration>>; publication: ConsentPublication } | undefined;

/** No implicit activation. Enforced bootstrap requires a real current approved registry row; tests use synthetic local rows. */
export async function bootstrapWorkerConsent(options: { mode: "off" | "enforced"; purpose?: string }) {
  if (options.mode === "off") { configureConsentDispatch({ mode: "off" }); return; }
  if (!options.purpose || !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(options.purpose)) throw new Error("Worker consent purpose required");
  const actual = await currentOpenAiRecipientConfiguration();
  const resolvePublication = async () => {
    const row = await readCurrentConsentPublication(options.purpose!);
    if (!row) return undefined;
    const currentActual = await currentOpenAiRecipientConfiguration();
    const publication: ConsentPublication = { approved: true, policyId: row.id, policyHash: row.content_hash, purpose: row.purpose, ...currentActual };
    if (runtime) { runtime.publication = publication; runtime.actual = currentActual; }
    return publication;
  };
  const publication = await resolvePublication();
  if (!publication) throw new Error("Worker consent publication not configured; no jobs admitted");
  runtime = { purpose: options.purpose, actual, publication };
  const observe: Parameters<typeof createConsentBatchAuthorizer>[1] = ({ publication: p, revisions }) => {
    const state = storage.getStore();
    if (!state) throw new AiConsentDenied("consent_required", "context_missing");
    for (const r of revisions) {
      const key = `${r.userId}:${p.purpose}`;
      const prior = state.epochs.get(key);
      if (prior && (prior.revision !== r.revision || prior.publication.policyId !== p.policyId || prior.publication.policyHash !== p.policyHash))
        throw new AiConsentDenied("consent_required", "not_granted");
      state.epochs.set(key, { ...r, publication: p, intent: state.intent });
    }
  };
  const authorize = async (input: Parameters<ReturnType<typeof createConsentBatchAuthorizer>>[0]) =>
    createConsentBatchAuthorizer(await currentOpenAiRecipientConfiguration(), observe)(input);
  configureConsentDispatch({ mode: "enforced", publication, resolvePublication, authorize });
}
export function workerConsentEnforced() { return !!runtime; }

/** DB ownership only. Client/job identity is never evidence of ownership. No source texts in sidecar. */
export async function resolveConsentSource(kind: Kind, data: Job["data"]) {
  const sql = getSql();
  let sourceId: string | undefined, owner: string | undefined, version: unknown;
  if (["profile_transcribe", "profile_extract", "profile_facts"].includes(kind)) {
    sourceId = data.sourceInputId;
    const [row] = await sql`SELECT *,to_jsonb(profile_source_inputs) AS consent_version FROM profile_source_inputs WHERE id=${sourceId ?? null}::uuid`;
    if (!row || row.revoked_at || row.status !== (kind === "profile_transcribe" ? "transcribing" : "confirmed") || (data.userId && data.userId !== row.user_id)) return null;
    owner = row.user_id; version = row.consent_version;
    if (row.audio_media_id) { const [media] = await sql`SELECT owner_id FROM media WHERE id=${row.audio_media_id}`; if (media?.owner_id !== owner) return null; }
  } else if (kind === "profile_rebuild" || kind === "embedding_refresh") {
    sourceId = data.userId; owner = data.userId;
    const [row] = await sql`SELECT p.*, jsonb_build_object('profile',to_jsonb(p),'decisionRevision',(SELECT max(seq) FROM profile_item_decisions d WHERE d.user_id=p.user_id)) AS consent_version
      FROM capability_profiles p WHERE user_id=${owner ?? null}::uuid AND status IN ('applied','invalidated','rebuild_pending') ORDER BY profile_version DESC LIMIT 1`;
    if (!row) return null;
    version = row.consent_version;
  } else {
    sourceId = data.orderId;
    const [row] = await sql`SELECT *,to_jsonb(orders) AS consent_version FROM orders WHERE id=${sourceId ?? null}::uuid`;
    if (!row || row.status === 'cancelled' || row.status === 'archived') return null;
    owner = row.author_id;
    const [doc] = await sql`SELECT id FROM matching_documents WHERE order_id=${sourceId!} ORDER BY created_at DESC LIMIT 1`;
    version = { id: row.id, author: owner, status: row.status, sourceText: row.source_text, sourceStatus: row.source_status, transcript: row.transcript, cityId: row.city_id, desiredAt: row.consent_version.desired_at, document: doc?.id ?? null };
    if (kind === "order_transcribe") {
      const media = await sql`SELECT m.owner_id FROM order_media om JOIN media m ON m.id=om.media_id WHERE om.order_id=${sourceId!} AND m.kind='audio'`;
      if (!media.length || media.some(m => m.owner_id !== owner)) return null;
    }
  }
  const [user] = await sql`SELECT status FROM users WHERE id=${owner!}::uuid`;
  if (user?.status !== "active") return null;
  return { sourceId: sourceId!, owner: owner!, versionHash: disclosureHash(JSON.parse(JSON.stringify(version))) };
}
async function pause(state: State, error: AiConsentDenied) {
  console.info(JSON.stringify({ event: "ai_consent_work_paused", kind: state.intent.kind, code: error.code, reason: error.reason }));
  let result;
  try { result = await getSql().begin(async tx => {
    await tx`SET LOCAL lock_timeout='2s'`;
    await tx`SET LOCAL statement_timeout='3s'`;
    return pauseConsentWork(state.intent,error.code,tx);
  }); }
  catch (failure) {
    const e=failure as {code?:string;cause?:{code?:string}};
    if ((e.code ?? e.cause?.code) !== "UX001") throw failure;
    const [active]=await getSql()`SELECT count(*)::integer n FROM users WHERE status='active' AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(state.intent.subjectUserIds)}::text::jsonb))`;
    if (active?.n === state.intent.subjectUserIds.length) throw failure;
    return; // Deletion committed while this completed/rolled-back job was persisting its pause.
  }
  if (!result.id) {
    // Deletion may remove the winner between INSERT and canonical read. Never acknowledge lost live work.
    const [active] = await getSql()`SELECT count(*)::integer n FROM users WHERE status='active' AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(state.intent.subjectUserIds)}::text::jsonb))`;
    if (active?.n === state.intent.subjectUserIds.length) throw new Error("Consent pause was not persisted");
  }
  state.blocked++;
}
async function inState<T>(state: State, run: () => Promise<T>) {
  return storage.run(state, () => withAiConsentContext({ subjectUserIds: state.intent.subjectUserIds, purpose: state.intent.purpose,
    operation: state.intent.kind, traceId: state.intent.executionId }, async () => {
    await assertAiConsentDispatch(runtime!.actual);
    return run();
  }));
}
export function consentJob<J extends Job, R>(kind: Kind, handler: (job: J) => Promise<R>) {
  return async (job: J): Promise<R | { paused: "consent" } | { skipped: "consent_source_obsolete" }> => {
    if (!runtime) return handler(job);
    const source = await resolveConsentSource(kind, job.data);
    if (!source) return { skipped: "consent_source_obsolete" };
    const state: State = { intent: { kind, sourceId: source.sourceId, executionId: job.id, sourceVersionHash: source.versionHash,
      subjectUserIds: [source.owner], purpose: runtime.purpose, policyId: runtime.publication.policyId,
      policyHash: runtime.publication.policyHash, recipientBinding: runtime.actual.recipientBinding }, epochs: new Map(), blocked: 0, pending: [] };
    let result: R;
    try { result = await inState(state, () => handler(job)); }
    catch (error) {
      await flushPauses(state);
      if (!(error instanceof AiConsentDenied)) throw error;
      // Resolver may have observed a new publication during this execution.
      state.intent = { ...state.intent, policyId: runtime.publication.policyId, policyHash: runtime.publication.policyHash, recipientBinding: runtime.actual.recipientBinding };
      await pause(state, error);
      return { paused: "consent" };
    }
    await flushPauses(state);
    return result;
  };
}
/** Fresh pair context avoids a denied candidate poisoning another candidate's sticky transport state. */
export async function consentPair<T>(userId: string, run: () => Promise<T>): Promise<{ allowed: true; value: T } | { allowed: false }> {
  const parent = storage.getStore();
  if (!runtime || !parent) return { allowed: true, value: await run() };
  const state: State = { intent: { ...parent.intent, subjectUserIds: [...new Set([...parent.intent.subjectUserIds, userId])].sort() }, epochs: new Map(parent.epochs), blocked: 0, parent, pending: parent.pending };
  try {
    const value = await inState(state, run);
    for (const [key, epoch] of state.epochs) parent.epochs.set(key, epoch);
    return { allowed: true, value };
  } catch (error) {
    if (!(error instanceof AiConsentDenied)) throw error;
    if (state.intent.kind === "matching_run") state.pending.push({ state, error });
    else await pause(state, error);
    parent.blocked++;
    return { allowed: false };
  }
}
async function flushPauses(state: State) {
  // Matching's transaction must release order/FK locks before sidecar insertion takes subject locks.
  for (const pending of state.pending) await pause(pending.state,pending.error);
  state.pending.length=0;
}
export function consentRunReusable() { return !storage.getStore()?.blocked; }
/** Call only in the result-write transaction, BEFORE any derived write or profile lock. No HTTP under these locks. */
export async function assertConsentResultCommit(tx: { execute: (statement: ReturnType<typeof query>) => Promise<unknown> }) {
  const state = storage.getStore();
  if (!runtime || !state?.epochs.size) return;
  const epochs = [...state.epochs.values()].sort((a,b) => a.userId.localeCompare(b.userId));
  for (const epoch of epochs) {
    const users = await tx.execute(state.intent.kind === "matching_run"
      ? query`SELECT status FROM users WHERE id=${epoch.userId}`
      : query`SELECT status FROM users WHERE id=${epoch.userId} FOR SHARE`) as unknown as { status: string }[];
    // Revoke locks user first, then this permission-only gate. Matching already holds order/FK locks,
    // so it MUST NOT upgrade/take an author user lock here. No network occurs after this shared gate.
    await tx.execute(query`SELECT pg_advisory_xact_lock_shared(hashtextextended(${epoch.userId},17))`);
    const rows = await tx.execute(query`SELECT p.status,p.is_current,p.content_hash,
      (SELECT coalesce(max(seq),0)::integer FROM consent_decisions WHERE user_id=${epoch.userId}) AS revision
      FROM consent_disclosures p WHERE p.id=${epoch.publication.policyId} FOR SHARE`) as unknown as { status: string; is_current: boolean; content_hash: string; revision: number }[];
    const row = rows[0];
    if (users[0]?.status !== "active" || !row || row.status !== "approved" || !row.is_current || row.content_hash !== epoch.publication.policyHash || row.revision !== epoch.revision)
      throw new AiConsentDenied("consent_required", "not_granted");
  }
}
/** Full pool revisions for whole-run validity. No user texts or positive permission cache. */
export async function workerConsentFingerprint() {
  if (!runtime) return null;
  const rows = await getSql()`SELECT u.id,u.status,coalesce(max(d.seq),0)::integer revision FROM users u LEFT JOIN consent_decisions d ON d.user_id=u.id GROUP BY u.id ORDER BY u.id`;
  const p = await getSql()`SELECT id,purpose,content_hash,status,is_current FROM consent_disclosures ORDER BY id`;
  return disclosureHash({ rows: [...rows], policies: [...p], recipient: runtime.actual.recipientBinding, purpose: runtime.purpose });
}

export async function consentSourceBlocked(kind: Kind, sourceId: string) {
  if (!runtime) return false;
  const [row] = await getSql()`SELECT 1 FROM ai_consent_blocked_work WHERE kind=${kind} AND source_id=${sourceId} AND state IN ('waiting','ready','leased') LIMIT 1`;
  return !!row;
}
/** Bounded restart-safe dispatcher. Source and permission are always fresh; old captured policy is never treated as current. */
export async function dispatchConsentWork(enqueue: (kind: Kind, data: Job["data"], singleton: string) => Promise<string | null>) {
  if (!runtime) return;
  for (const claim of await claimConsentWork(10, 30, getSql(), runtime.purpose)) {
    const kind = claim.kind as Kind;
    const data: Job["data"] = kind.startsWith("order_") || kind === "matching_run" ? { orderId: claim.source_id }
      : kind === "profile_rebuild" || kind === "embedding_refresh" ? { userId: claim.source_id }
      : { sourceInputId: claim.source_id };
    const source = await resolveConsentSource(kind, data);
    if (!source || !claim.subject_user_ids.includes(source.owner) || source.versionHash !== claim.source_version_hash) { console.info(JSON.stringify({event:"ai_consent_resume_obsolete",kind,missing:!source,versionChanged:!!source && source.versionHash!==claim.source_version_hash})); await acknowledgeConsentWork(claim, "obsolete"); continue; }
    // Reconstruct trusted owner instead of replaying job payload or saved source text.
    if ("sourceInputId" in data) data.userId = source.owner;
    const state: State = { intent: { kind, sourceId: source.sourceId, executionId: claim.execution_id, sourceVersionHash: source.versionHash,
      subjectUserIds: claim.subject_user_ids, purpose: runtime.purpose, policyId: runtime.publication.policyId,
      policyHash: runtime.publication.policyHash, recipientBinding: runtime.actual.recipientBinding }, epochs: new Map(), blocked: 0, pending: [] };
    try {
      await inState(state, async () => undefined);
      // Stable source singleton prevents enqueue-before-ack crash from producing concurrent duplicate work.
      const id = await enqueue(kind, data, `${({ profile_extract: "profile-extraction", profile_transcribe: "profile-transcribe", embedding_refresh: "profile-embedding", profile_rebuild: "profile-rebuild" } as Partial<Record<Kind,string>>)[kind] ?? `consent:${kind}`}:${source.sourceId}`);
      await acknowledgeConsentWork(claim, id ? "enqueued" : "policy_unavailable");
    } catch (error) {
      if (!(error instanceof AiConsentDenied)) throw error;
      console.info(JSON.stringify({event:"ai_consent_resume_denied",kind,code:error.code,reason:error.reason}));
      await acknowledgeConsentWork(claim, error.code);
    }
  }
}
