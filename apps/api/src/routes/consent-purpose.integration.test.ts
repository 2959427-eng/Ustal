import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql, createConsentBatchAuthorizer, closeConsentAuthorizationPool } from "@ustal/database";
import consentRoutes from "./consents.js";
import { disclosureHash } from "../lib/consents.js";

assertLocalTestDatabase();
const db = getSql();
const app = Fastify();
const content = { title: "TEST FIXTURE ONLY", recipients: ["TEST provider"], text: "Synthetic disclosure" };
beforeAll(async () => {
  app.decorateRequest("userId", "");
  app.decorate("authenticate", async (request: any, reply: any) => {
    const id = request.headers["x-test-user"];
    if (!id) return reply.code(401).send({ error: { code: "unauthorized" } });
    request.userId = id;
  });
  await app.register(consentRoutes);
});
afterAll(async () => { vi.unstubAllEnvs(); await closeConsentAuthorizationPool(); await app.close(); await db.end(); });
describe("configured AI purpose authorization", () => {
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
});
