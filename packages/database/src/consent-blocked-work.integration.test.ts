import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getSql } from "./client.js";
import { assertLocalTestDatabase } from "./test-safety.js";
import { pauseConsentWork, claimConsentWork, wakeConsentWork, acknowledgeConsentWork, obsoleteConsentWork } from "./consent-blocked-work.js";
assertLocalTestDatabase();
const sql = getSql();
afterAll(() => sql.end());
async function fixture() {
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await sql`INSERT INTO users(id,phone,password_hash) VALUES(${id},${`t_${id.slice(0,15)}`},'fixture')`;
  return { kind: "profile_extract" as const, sourceId: randomUUID(), executionId: randomUUID(), sourceVersionHash: "a".repeat(64), subjectUserIds: ids,
    purpose: `test-${randomUUID()}`, policyId: randomUUID(), policyHash: "b".repeat(64), recipientBinding: "c".repeat(64) };
}
async function ready() {
  const input = await fixture(); const paused = await pauseConsentWork(input, "consent_required");
  await wakeConsentWork(input.subjectUserIds[0]!, input.purpose);
  return { input, id: paused.id! };
}
async function claimId(id: string) {
  const rows = await claimConsentWork(25);
  const found = rows.find(r => r.id === id); expect(found).toBeDefined(); return found!;
}
describe.sequential("isolated dormant sidecar primitives", () => {
  it("does not lose a grant signal committed before the pause row exists", async () => {
    const input = await fixture();
    expect(await wakeConsentWork(input.subjectUserIds[0]!, input.purpose)).toBe(0);
    const paused = await pauseConsentWork(input, "consent_required");
    const first = await claimId(paused.id!);
    await acknowledgeConsentWork(first, "consent_required");
    expect((await claimConsentWork()).map(row => row.id)).not.toContain(paused.id);
    await obsoleteConsentWork(input.kind, input.sourceId, null);
  });
  it("a resumed execution can pause again after handoff without reopening the old execution", async () => {
    const input = { ...await fixture(), executionId: randomUUID() };
    const paused = await pauseConsentWork(input, "consent_required");
    await wakeConsentWork(input.subjectUserIds[0]!, input.purpose);
    const first = await claimId(paused.id!);
    expect(await acknowledgeConsentWork(first, "enqueued")).toBe(true);
    const again = await pauseConsentWork({ ...input, executionId: randomUUID() }, "consent_required");
    expect(again.inserted).toBe(true);
    expect(again.id).not.toBe(paused.id);
    await obsoleteConsentWork(input.kind, input.sourceId, null);
  });
  it("preserves separate STT reconstruction kinds even when configured publication is absent", async () => {
    const input = await fixture();
    const a = await pauseConsentWork({...input,kind:"profile_transcribe"},"consent_required");
    const b = await pauseConsentWork({...input,kind:"order_transcribe"},"consent_required");
    expect(a.id).not.toBe(b.id);
    const rows = await sql`SELECT kind FROM ai_consent_blocked_work WHERE id IN (${a.id!},${b.id!}) ORDER BY kind`;
    expect(rows.map(r=>r.kind)).toEqual(["order_transcribe","profile_transcribe"]);
    await obsoleteConsentWork("profile_transcribe",input.sourceId,null);
    await obsoleteConsentWork("order_transcribe",input.sourceId,null);
  });
  it("0029 follows 0028 additively, preserves registry/evidence and introduces no queue writes", async () => {
    const [row] = await sql`SELECT to_regclass('consent_decisions') AS evidence,to_regclass('ai_consent_blocked_work') AS sidecar`;
    expect(row!.evidence).toBe("consent_decisions"); expect(row!.sidecar).toBe("ai_consent_blocked_work");
    const [count] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`; expect(count!.n).toBe(30);
  });
  it("concurrent pause has one canonical row and duplicate delivery does not reset state", async () => {
    const input = await fixture(); const rows = await Promise.all(Array.from({ length: 4 }, () => pauseConsentWork(input,"consent_required")));
    expect(new Set(rows.map(r => r.id)).size).toBe(1); expect(rows.filter(r => r.inserted)).toHaveLength(1);
    await wakeConsentWork(input.subjectUserIds[0]!, input.purpose); const claimed = await claimId(rows[0]!.id!);
    await pauseConsentWork(input, "policy_unavailable");
    expect(await acknowledgeConsentWork(claimed,"enqueued")).toBe(true);
    await pauseConsentWork(input,"consent_required");
    const [row] = await sql`SELECT state FROM ai_consent_blocked_work WHERE id=${claimed.id}`; expect(row!.state).toBe("enqueued");
  });
  it("two concurrent SKIP LOCKED claimers never own the same row", async () => {
    const a = await ready(), b = await ready();
    const [first,second] = await Promise.all([claimConsentWork(1),claimConsentWork(1)]);
    expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(new Set([first[0]!.id,second[0]!.id])).toEqual(new Set([a.id,b.id]));
    await Promise.all([...first,...second].map(c => acknowledgeConsentWork(c,"obsolete")));
  });
  it("crash/expired lease is reclaimable and old token or expired acknowledgement is fenced", async () => {
    const f = await ready(), old = await claimId(f.id);
    await sql`UPDATE ai_consent_blocked_work SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${f.id}`;
    expect(await acknowledgeConsentWork(old,"enqueued")).toBe(false);
    const next = await claimId(f.id); expect(next.lease_token).not.toBe(old.lease_token);
    expect(await acknowledgeConsentWork(old,"obsolete")).toBe(false);
    expect(await acknowledgeConsentWork(next,"enqueued")).toBe(true);
    expect(await acknowledgeConsentWork(next,"enqueued")).toBe(false);
  });
  it("missing grant waits for signal; grant wake is atomic and never writes the external queue", async () => {
    const f = await ready(), c = await claimId(f.id);
    expect(await acknowledgeConsentWork(c,"consent_required")).toBe(true);
    expect((await claimConsentWork()).map(r => r.id)).not.toContain(f.id);
    await expect(sql.begin(async tx => { await wakeConsentWork(f.input.subjectUserIds[0]!,f.input.purpose,tx); throw new Error("fixture rollback"); })).rejects.toThrow("fixture rollback");
    let [row] = await sql`SELECT state FROM ai_consent_blocked_work WHERE id=${f.id}`; expect(row!.state).toBe("waiting");
    await sql.begin(async tx => { await tx`SELECT id FROM users WHERE id=${f.input.subjectUserIds[0]!} FOR UPDATE`; await wakeConsentWork(f.input.subjectUserIds[0]!,f.input.purpose,tx); });
    const next = await claimId(f.id); await acknowledgeConsentWork(next,"obsolete");
    [row] = await sql`SELECT count(*)::int AS n FROM background_jobs`; expect(row!.n).toBe(0);
  });
  it("wake during claim is not lost when stale permission check returns missing grant", async () => {
    const f = await ready(), c = await claimId(f.id);
    await wakeConsentWork(f.input.subjectUserIds[1]!,f.input.purpose);
    expect(await acknowledgeConsentWork(c,"consent_required")).toBe(true);
    const next = await claimId(f.id); expect(next.wake_seq).toBeGreaterThan(c.wake_seq);
    await acknowledgeConsentWork(next,"obsolete");
  });
  it("temporary policy outage has bounded probes without fabricated grants or grant signals", async () => {
    const f = await ready(), c = await claimId(f.id);
    await acknowledgeConsentWork(c,"policy_unavailable");
    const [row] = await sql`SELECT state,attempts,extract(epoch FROM next_probe_at-clock_timestamp()) AS delay FROM ai_consent_blocked_work WHERE id=${f.id}`;
    expect(row!.state).toBe("ready"); expect(row!.attempts).toBe(1); expect(Number(row!.delay)).toBeGreaterThan(8); expect(Number(row!.delay)).toBeLessThanOrEqual(10);
    expect((await claimConsentWork()).map(r => r.id)).not.toContain(f.id);
    await sql`UPDATE ai_consent_blocked_work SET next_probe_at=clock_timestamp()-interval '1 second',attempts=100 WHERE id=${f.id}`;
    const next = await claimId(f.id); await acknowledgeConsentWork(next,"policy_unavailable");
    const [cap] = await sql`SELECT extract(epoch FROM next_probe_at-clock_timestamp()) AS delay FROM ai_consent_blocked_work WHERE id=${f.id}`;
    expect(Number(cap!.delay)).toBeGreaterThan(898); expect(Number(cap!.delay)).toBeLessThanOrEqual(900);
    await obsoleteConsentWork(f.input.kind,f.input.sourceId,null);
    const [evidence] = await sql`SELECT count(*)::int AS n FROM consent_decisions WHERE user_id IN (${f.input.subjectUserIds[0]!},${f.input.subjectUserIds[1]!})`; expect(evidence!.n).toBe(0);
  });
  it("source replacement makes only old intent obsolete and fences its in-flight ack", async () => {
    const f = await ready(), old = await claimId(f.id);
    const newer = await pauseConsentWork({...f.input,sourceVersionHash:"d".repeat(64)},"consent_required");
    expect(await obsoleteConsentWork(f.input.kind,f.input.sourceId,"d".repeat(64))).toBe(1);
    expect(await acknowledgeConsentWork(old,"enqueued")).toBe(false);
    const [row] = await sql`SELECT state FROM ai_consent_blocked_work WHERE id=${newer.id!}`; expect(row!.state).toBe("ready");
    await obsoleteConsentWork(f.input.kind,f.input.sourceId,null);
  });
  it("deleted-subject insertion is blocked; deletion cleans waiting AND leased work", async () => {
    const f = await ready(), c = await claimId(f.id);
    const waiting = await pauseConsentWork({...f.input,sourceVersionHash:"e".repeat(64)},"consent_required");
    await acknowledgeConsentWork(await claimId(waiting.id!),"consent_required");
    await sql`UPDATE users SET status='deleted' WHERE id=${f.input.subjectUserIds[1]!}`;
    expect(await acknowledgeConsentWork(c,"enqueued")).toBe(false);
    expect(await pauseConsentWork(f.input,"consent_required").catch(e => e.code)).toBe("UX001");
    const [row] = await sql`SELECT count(*)::int AS n FROM ai_consent_blocked_work WHERE id=${f.id}`; expect(row!.n).toBe(0);
    const [other] = await sql`SELECT count(*)::int AS n FROM ai_consent_blocked_work WHERE id=${waiting.id!}`; expect(other!.n).toBe(0);
  });
  it("identity mutation cannot add a deleted subject; state-only updates never take subject locks", async () => {
    const f = await ready(); const dead = await fixture();
    await sql`UPDATE users SET status='deleted' WHERE id=${dead.subjectUserIds[0]!}`;
    await expect(sql`UPDATE ai_consent_blocked_work SET subject_user_ids=ARRAY[${dead.subjectUserIds[0]!}::uuid] WHERE id=${f.id}`).rejects.toMatchObject({code:"UX014"});
    // If state triggers lock other subjects, two independent grant transactions deadlock here.
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { entered=resolve; });
    const holding = sql.begin(async tx => {
      await tx`SELECT id FROM users WHERE id=${f.input.subjectUserIds[1]!} FOR UPDATE`; entered();
      await new Promise<void>(resolve => { release=resolve; });
    });
    await barrier;
    try {
      const action = sql.begin(async tx => {
        await tx`SET LOCAL statement_timeout='1000ms'`;
        await tx`SELECT id FROM users WHERE id=${f.input.subjectUserIds[0]!} FOR UPDATE`;
        await wakeConsentWork(f.input.subjectUserIds[0]!,f.input.purpose,tx);
        const [claim] = await claimConsentWork(25,30,tx);
        expect(claim).toBeDefined(); await acknowledgeConsentWork(claim!,"obsolete",tx);
      });
      await expect(action).resolves.toBeUndefined();
    } finally { release(); await holding; }
  });
  it("concurrent delete/insert either rejects insert or removes it, never resurrects", async () => {
    for (let n=0;n<4;n++) {
      const input = await fixture();
      const result = await Promise.allSettled([pauseConsentWork(input,"consent_required"),sql`UPDATE users SET status='deleted' WHERE id=${input.subjectUserIds[0]!}`]);
      expect(result[1]!.status).toBe("fulfilled");
      const [row] = await sql`SELECT count(*)::int AS n FROM ai_consent_blocked_work WHERE subject_user_ids @> ARRAY[${input.subjectUserIds[0]!}::uuid]`; expect(row!.n).toBe(0);
    }
  });
});
