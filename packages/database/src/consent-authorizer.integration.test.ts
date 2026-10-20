import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getSql } from "./client.js";
import { assertLocalTestDatabase } from "./test-safety.js";
import { createConsentBatchAuthorizer, disclosureHash, decideConsent, closeConsentAuthorizationPool, ConsentAuthorizationUnavailable } from "./consents.js";
assertLocalTestDatabase();
const db = getSql();
const actual = { provider: "openai", endpoint: "https://fixture.invalid/v1", recipientBinding: "a".repeat(64) };
afterAll(async () => { await closeConsentAuthorizationPool(); await db.end(); });
async function fixture(modify: (content: any) => void = () => {}) {
  const ids = [randomUUID(), randomUUID()], policyId = randomUUID(), purpose = `ai-${randomUUID()}`;
  const content = { humanText: "TEST ONLY synthetic disclosure, not an actual approval", aiDispatch: { schemaVersion: 1, purpose,
    recipients: [{ name: "TEST ONLY recipient", ...actual }] } };
  modify(content); const policyHash = disclosureHash(content);
  for (const id of ids) await db`INSERT INTO users(id,phone,password_hash) VALUES(${id},${`t_${id.slice(0, 15)}`},'fixture')`;
  await db`INSERT INTO consent_disclosures(id,purpose,version,content,content_hash,status,is_current)
    VALUES(${policyId},${purpose},'test',${db.json(content)},${policyHash},'approved',true)`;
  const publication = { approved: true as const, policyId, policyHash, purpose, ...actual };
  const input = { subjectUserIds: ids, publication, operation: "fixture", traceId: "fixture" };
  const grant = async (id: string, revision = 0) => decideConsent(id, { policyId, policyHash, decision: "grant", expectedRevision: revision });
  return { ids, policyId, policyHash, publication, input, grant };
}
describe("single-snapshot shared consent authorizer", () => {
  it("denies absent/one-party grants; grants both; rereads revoke/deleted/unknown users", async () => {
    const f = await fixture(), authorize = createConsentBatchAuthorizer(actual);
    expect(await authorize(f.input)).toBe(false); await f.grant(f.ids[0]!); expect(await authorize(f.input)).toBe(false);
    await f.grant(f.ids[1]!); expect(await authorize(f.input)).toBe(true);
    await decideConsent(f.ids[0]!, { policyId: f.policyId, policyHash: f.policyHash, decision: "revoke", expectedRevision: 1 });
    expect(await authorize(f.input)).toBe(false); await f.grant(f.ids[0]!, 2); expect(await authorize(f.input)).toBe(true);
    await db`UPDATE users SET status='deleted' WHERE id=${f.ids[1]!}`; expect(await authorize(f.input)).toBe(false);
    expect(await authorize({ ...f.input, subjectUserIds: [randomUUID()] })).toBe(false);
  });
  it("denies noncurrent/draft/retired or mismatched publication/actual identity", async () => {
    const f = await fixture(); for (const id of f.ids) await f.grant(id);
    for (const change of [{ policyHash: "b".repeat(64) }, { policyId: randomUUID() }, { purpose: "other" }, { recipientBinding: "c".repeat(64) }])
      expect(await createConsentBatchAuthorizer(actual)({ ...f.input, publication: { ...f.publication, ...change } })).toBe(false);
    for (const change of [{ provider: "other" }, { endpoint: "https://other.invalid/v1" }, { recipientBinding: "b".repeat(64) }])
      expect(await createConsentBatchAuthorizer({ ...actual, ...change })(f.input)).toBe(false);
    for (const status of ["draft", "retired"]) { await db`UPDATE consent_disclosures SET status=${status} WHERE id=${f.policyId}`; expect(await createConsentBatchAuthorizer(actual)(f.input)).toBe(false); }
    await db`UPDATE consent_disclosures SET status='approved',is_current=false WHERE id=${f.policyId}`;
    expect(await createConsentBatchAuthorizer(actual)(f.input)).toBe(false);
  });
  it("requires human text, known section, exact one matching recipient and matching content hash", async () => {
    for (const modify of [(c: any) => { c.humanText = "TBD"; }, (c: any) => { delete c.aiDispatch; },
      (c: any) => { c.aiDispatch.recipients.push(c.aiDispatch.recipients[0]); }, (c: any) => { c.aiDispatch.recipients[0].name = ""; }]) {
      const f = await fixture(modify); for (const id of f.ids) await f.grant(id);
      expect(await createConsentBatchAuthorizer(actual)(f.input)).toBe(false);
    }
  });
  it("reads every identity in one statement snapshot, never mixing A-only and B-only commits", async () => {
    const f = await fixture(); await f.grant(f.ids[0]!);
    const authorize = createConsentBatchAuthorizer(actual);
    const checks: boolean[] = [];
    for (let n = 0; n < 8; n++) {
      const checking = authorize(f.input).catch(error => error as Error);
      await db.begin(async tx => {
        const a = f.ids[n % 2]!, b = f.ids[(n + 1) % 2]!;
        const [ar] = await tx`SELECT coalesce(max(seq),0)+1 AS seq FROM consent_decisions WHERE user_id=${a}`;
        await tx`INSERT INTO consent_decisions(user_id,actor_user_id,seq,policy_id,policy_hash,decision) VALUES(${a},${a},${ar!.seq},${f.policyId},${f.policyHash},'revoke')`;
        const [br] = await tx`SELECT coalesce(max(seq),0)+1 AS seq FROM consent_decisions WHERE user_id=${b}`;
        await tx`INSERT INTO consent_decisions(user_id,actor_user_id,seq,policy_id,policy_hash,decision) VALUES(${b},${b},${br!.seq},${f.policyId},${f.policyHash},'grant')`;
      });
      const checked = await checking; expect(checked).toBe(false); checks.push(checked as boolean);
    }
    expect(checks).toEqual(Array(8).fill(false));
  });
  it("uses a dedicated bounded pool; DB lock/unavailability is sanitized, never an allowed decision", async () => {
    const f = await fixture(); for (const id of f.ids) await f.grant(id);
    const authorize = createConsentBatchAuthorizer(actual), started = Date.now();
    await db.begin(async tx => {
      await tx`LOCK TABLE consent_decisions IN ACCESS EXCLUSIVE MODE`;
      const error = await authorize(f.input).catch(e => e);
      expect(error).toBeInstanceOf(ConsentAuthorizationUnavailable);
      expect(String(error) + JSON.stringify(error)).not.toMatch(/postgres:|password|SELECT|consent_decisions|fixture.invalid/);
    });
    expect(Date.now() - started).toBeLessThan(4500);
    expect(await authorize(f.input)).toBe(true);
  });
});
