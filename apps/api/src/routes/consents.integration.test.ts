import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql, createConsentBatchAuthorizer, closeConsentAuthorizationPool } from "@ustal/database";
import consentRoutes from "./consents.js";
import { disclosureHash } from "../lib/consents.js";

assertLocalTestDatabase();
const db = getSql();
const app = Fastify();
const actor = randomUUID(), other = randomUUID();
const draft = randomUUID(), approved = randomUUID(), old = randomUUID();
const purpose = `consent-test-${randomUUID()}`;
const content = { title: "TEST FIXTURE ONLY", recipients: ["TEST provider"], text: "Synthetic disclosure" };
const hash = disclosureHash(content);
const headers = { "x-test-user": actor };
const read = () => app.inject({ method: "GET", url: "/me/consents", headers });
const decide = (decision: string, revision: number, policyId = approved, extra = {}) => app.inject({
  method: "POST", url: "/me/consents", headers,
  payload: { policyId, policyHash: hash, decision, expectedRevision: revision, ...extra },
});

beforeAll(async () => {
  await db`INSERT INTO users(id, phone, password_hash) VALUES (${actor}, ${`test_${actor.slice(0, 12)}`}, 'test'), (${other}, ${`test_${other.slice(0, 12)}`}, 'test')`;
  await db`INSERT INTO consent_disclosures(id, purpose, version, content, content_hash, status, is_current)
    VALUES (${draft}, ${purpose + '-draft'}, 'draft', ${db.json(content)}, ${hash}, 'draft', true),
    (${approved}, ${purpose}, 'approved-test', ${db.json(content)}, ${hash}, 'approved', true),
    (${old}, ${purpose}, 'old-test', ${db.json(content)}, ${hash}, 'approved', false)`;
  app.decorateRequest("userId", "");
  app.decorate("authenticate", async (request: any, reply: any) => {
    const id = request.headers["x-test-user"];
    if (!id) return reply.code(401).send({ error: { code: "unauthorized" } });
    request.userId = id;
  });
  await app.register(consentRoutes);
});
afterAll(async () => { await app.close(); await closeConsentAuthorizationPool(); await db.end(); });

describe("consent infrastructure (no outbound enforcement)", () => {
  it("requires auth; existing users have revision zero and no fabricated grant", async () => {
    expect((await app.inject("/me/consents")).statusCode).toBe(401);
    const res = await read(); expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(0); expect(res.json().decisions).toEqual([]);
  });
  it("rejects draft, old, unknown, hash mismatch and spoofed identities without evidence", async () => {
    for (const res of [await decide("grant", 0, draft), await decide("grant", 0, old),
      await decide("grant", 0, randomUUID()), await decide("grant", 0, approved, { policyHash: "0".repeat(64) }),
      await decide("grant", 0, approved, { userId: other })]) expect([400, 409]).toContain(res.statusCode);
    expect((await read()).json().revision).toBe(0);
  });
  it("serializes concurrent decisions, returns controlled conflict, records actor and monotonic revision", async () => {
    const results = await Promise.all([decide("grant", 0), decide("revoke", 0)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const current = (await read()).json(); expect(current.revision).toBe(1);
    expect(current.decisions).toHaveLength(1); expect(current.decisions[0].actorUserId).toBe(actor);
    expect(current.decisions[0].policyHash).toBe(hash);
    expect((await decide("revoke", 1)).statusCode).toBe(200);
    expect((await read()).json().revision).toBe(2);
    const repeat = await decide("revoke", 2); expect(repeat.statusCode).toBe(200);
    expect(repeat.json().changed).toBe(false); expect(repeat.json().revision).toBe(2);
  });
  it("keeps users isolated, cannot mutate evidence, binds immutable disclosure, allows revoke after retirement", async () => {
    expect((await app.inject({ method: "GET", url: "/me/consents", headers: { "x-test-user": other } })).json().revision).toBe(0);
    expect((await decide("grant", 2)).statusCode).toBe(200);
    await db`UPDATE consent_disclosures SET status='retired', is_current=false WHERE id=${approved}`;
    expect((await decide("revoke", 3)).statusCode).toBe(200);
    await expect(db`UPDATE consent_decisions SET decision='grant' WHERE user_id=${actor}`).rejects.toThrow();
    await expect(db`DELETE FROM consent_decisions WHERE user_id=${actor}`).rejects.toThrow();
    await expect(db`UPDATE consent_disclosures SET content_hash=${"0".repeat(64)} WHERE id=${approved}`).rejects.toThrow();
  });
  it("database guard independently rejects draft grant, forged actor and skipped revision", async () => {
    await expect(db`INSERT INTO consent_decisions(user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${other}, ${other}, 1, ${draft}, ${hash}, 'grant')`).rejects.toThrow();
    await expect(db`INSERT INTO consent_decisions(user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${other}, ${actor}, 1, ${draft}, ${hash}, 'revoke')`).rejects.toThrow();
    await expect(db`INSERT INTO consent_decisions(user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${other}, ${other}, 2, ${draft}, ${hash}, 'revoke')`).rejects.toThrow();
    expect((await app.inject({ method: "GET", url: "/me/consents", headers: { "x-test-user": other } })).json().revision).toBe(0);
  });
  it("identifies configured AI purpose among approved policies; deny/revoke stop actual AI authorization only for that purpose", async () => {
    const userId = randomUUID(), aiId = randomUUID(), unrelatedId = randomUUID();
    const aiPurpose = `z-ai-${randomUUID()}`, unrelatedPurpose = `aaa-${randomUUID()}`;
    const actual = { provider: "openai", endpoint: "https://fixture.invalid/v1", recipientBinding: "a".repeat(64) };
    const aiContent = { humanText: "TEST ONLY synthetic AI disclosure", aiDispatch: { schemaVersion: 1, purpose: aiPurpose,
      recipients: [{ name: "TEST ONLY recipient", ...actual }] } };
    const aiHash = disclosureHash(aiContent), unrelatedHash = disclosureHash(content);
    await db`INSERT INTO users(id, phone, password_hash) VALUES (${userId}, ${`t_${userId.slice(0, 15)}`}, 'fixture')`;
    await db`INSERT INTO consent_disclosures(id, purpose, version, content, content_hash, status, is_current)
      VALUES (${aiId}, ${aiPurpose}, '1', ${db.json(aiContent)}, ${aiHash}, 'approved', true),
      (${unrelatedId}, ${unrelatedPurpose}, '1', ${db.json(content)}, ${unrelatedHash}, 'approved', true)`;
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "enforced");
    vi.stubEnv("USTAL_AI_CONSENT_PURPOSE", aiPurpose);
    try {
      const userHeaders = { "x-test-user": userId };
      const readCurrent = async () => (await app.inject({ method: "GET", url: "/me/consents", headers: userHeaders })).json();
      const initial = await readCurrent();
      expect(initial.aiConsentPurpose).toBe(aiPurpose);
      expect(initial.outboundEnforcement).toBe(true);
      expect(initial.policies.find((p: { id: string }) => p.id === unrelatedId)).toBeDefined();
      const authorize = createConsentBatchAuthorizer(actual);
      const authorization = { subjectUserIds: [userId], publication: { approved: true as const, policyId: aiId,
        policyHash: aiHash, purpose: aiPurpose, ...actual }, operation: "fixture", traceId: "fixture" };
      const post = (policyId: string, policyHash: string, decision: "grant" | "revoke", expectedRevision: number) =>
        app.inject({ method: "POST", url: "/me/consents", headers: userHeaders, payload: { policyId, policyHash, decision, expectedRevision } });
      expect((await post(unrelatedId, unrelatedHash, "grant", 0)).statusCode).toBe(200);
      expect(await authorize(authorization)).toBe(false);
      expect((await post(aiId, aiHash, "revoke", 1)).statusCode).toBe(200); // initial denial
      expect(await authorize(authorization)).toBe(false);
      expect((await post(aiId, aiHash, "grant", 2)).statusCode).toBe(200);
      expect(await authorize(authorization)).toBe(true);
      expect((await post(aiId, aiHash, "revoke", 3)).statusCode).toBe(200);
      expect(await authorize(authorization)).toBe(false);
      const after = await readCurrent();
      expect(after.decisions.find((d: { purpose: string }) => d.purpose === aiPurpose)).toMatchObject({ decision: "revoke", effective: false });
      expect(after.decisions.find((d: { purpose: string }) => d.purpose === unrelatedPurpose)).toMatchObject({ decision: "grant", effective: true });
      expect((await post(aiId, aiHash, "grant", 4)).statusCode).toBe(200);
      expect(await authorize(authorization)).toBe(true);
      const nextId = randomUUID();
      await db`UPDATE consent_disclosures SET is_current=false WHERE id=${aiId}`;
      await db`INSERT INTO consent_disclosures(id, purpose, version, content, content_hash, status, is_current)
        VALUES (${nextId}, ${aiPurpose}, '2', ${db.json(aiContent)}, ${aiHash}, 'approved', true)`;
      expect(await authorize({ ...authorization, publication: { ...authorization.publication, policyId: nextId } })).toBe(false);
      expect((await readCurrent()).decisions.find((d: { purpose: string }) => d.purpose === aiPurpose)).toMatchObject({ decision: "grant", effective: false });
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects deleted user late writes even when authentication raced; read is also controlled", async () => {
    await db`UPDATE users SET status='deleted' WHERE id=${actor}`;
    expect((await read()).statusCode).toBe(401);
    expect((await decide("revoke", 4)).statusCode).toBe(401);
    await expect(db`INSERT INTO consent_decisions(user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${actor}, ${actor}, 5, ${approved}, ${hash}, 'revoke')`).rejects.toThrow();
  });
});
