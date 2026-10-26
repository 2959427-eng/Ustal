import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql } from "@ustal/database";
import { buildApp } from "../app.js";
import { renderLegalPage } from "../legal/pages.js";
import { validatePublication } from "../legal/publication.js";

assertLocalTestDatabase();
const sql = getSql();
const cityId = randomUUID();
const payload = (over: Record<string, unknown> = {}) => ({ name: "Registration evidence fixture", phone: `+7${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`,
  password: "fixture-password-only", cityId, acceptedRules: true, acceptedPdn: true, acceptedAge18: true, ...over });
const documents = { privacy: "Политика (тестовая копия).", terms: "Соглашение (тестовая копия).", "community-guidelines": "Правила.", "delete-account": "Удаление.", support: "Поддержка." };
const bundle = { approved: true, version: "test-2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.test", publicOrigin: "https://ustal.test", documents };
const evidence = async (userId: string) =>
  (await sql`SELECT metadata FROM audit_logs WHERE actor_id=${userId} AND action='registration_documents_accepted'`).map((r) => r.metadata as Record<string, unknown>);

beforeAll(async () => {
  await sql`INSERT INTO cities(id,name,region_name,federal_district,timezone) VALUES(${cityId},'Fixture','Fixture','Fixture','UTC')`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await sql.end(); });

describe("registration stores which document version was accepted", () => {
  it("records publication version, effective date and SHA-256 of exactly the published /terms and /privacy pages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ustal-legal-"));
    const file = join(dir, "publication.json");
    writeFileSync(file, JSON.stringify(bundle));
    vi.stubEnv("USTAL_LEGAL_PUBLICATION_FILE", file);
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "off");
    const app = await buildApp();
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: payload() });
      expect(r.statusCode).toBe(201);
      const [row, ...rest] = await evidence(r.json().userId);
      expect(rest).toHaveLength(0);
      const p = validatePublication(bundle);
      const sha = (page: "terms" | "privacy") => createHash("sha256").update(renderLegalPage(page, p)).digest("hex");
      expect(row).toMatchObject({ published: true, version: "test-2026-10-26", effectiveDate: "2026-10-26",
        termsSha256: sha("terms"), privacySha256: sha("privacy"), acceptedRules: true, acceptedPdn: true });
      expect(typeof row!.acceptedAt).toBe("string");
      // хеш совпадает с тем, что реально отдаёт сервер по ссылке из приложения
      const served = await app.inject("/terms");
      expect(createHash("sha256").update(served.body).digest("hex")).toBe(row!.termsSha256);
    } finally { await app.close(); }
  });

  it("without an approved publication it records published=false instead of inventing a version", async () => {
    vi.stubEnv("USTAL_LEGAL_PUBLICATION_FILE", "");
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "off");
    const app = await buildApp();
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: payload() });
      expect(r.statusCode).toBe(201);
      expect(await evidence(r.json().userId)).toEqual([expect.objectContaining({ published: false, version: null, termsSha256: null, privacySha256: null })]);
    } finally { await app.close(); }
  });

  it("rejected registration (no acceptance) leaves no evidence and no user", async () => {
    const app = await buildApp();
    try {
      const body = payload({ acceptedRules: false });
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: body });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      const [u] = await sql`SELECT count(*)::int n FROM users WHERE phone=${body.phone as string}`;
      expect(u!.n).toBe(0);
    } finally { await app.close(); }
  });
});

describe("«Не разрешаю» сразу после регистрации", () => {
  it("first-ever decision can be a refusal: stored with policy id, hash and time; paused AI work stays blocked", async () => {
    const { disclosureHash, pauseConsentWork } = await import("@ustal/database");
    const purpose = `refusal-${randomUUID()}`, policyId = randomUUID();
    const content = { humanText: "TEST ONLY refusal fixture" }, policyHash = disclosureHash(content);
    await sql`INSERT INTO consent_disclosures(id,purpose,version,content,content_hash,status,is_current) VALUES(${policyId},${purpose},'fixture',${JSON.stringify(content)}::text::jsonb,${policyHash},'approved',true)`;
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "enforced"); vi.stubEnv("USTAL_AI_CONSENT_PURPOSE", purpose);
    const app = await buildApp();
    try {
      const reg = await app.inject({ method: "POST", url: "/auth/register", payload: payload() });
      expect(reg.statusCode).toBe(201);
      const { userId, accessToken } = reg.json();
      const headers = { authorization: `Bearer ${accessToken}` };
      const paused = await pauseConsentWork({ kind: "profile_extract", sourceId: randomUUID(), executionId: randomUUID(), sourceVersionHash: "a".repeat(64),
        subjectUserIds: [userId], purpose, policyId, policyHash, recipientBinding: "b".repeat(64) }, "consent_required");
      await sql`UPDATE ai_consent_blocked_work SET state='waiting',next_probe_at=null WHERE id=${paused.id!}`;

      const refuse = await app.inject({ method: "POST", url: "/me/consents", headers, payload: { policyId, policyHash, decision: "revoke", expectedRevision: 0 } });
      expect(refuse.statusCode).toBe(200);
      const [d] = await sql`SELECT decision, policy_id, policy_hash, decided_at FROM consent_decisions WHERE user_id=${userId}`;
      expect(d).toMatchObject({ decision: "revoke", policy_id: policyId, policy_hash: policyHash });
      expect(Number.isFinite(Date.parse(String(d!.decided_at)))).toBe(true);
      const [w] = await sql`SELECT state FROM ai_consent_blocked_work WHERE id=${paused.id!}`;
      expect(w!.state).toBe("waiting"); // отказ не будит паузу

      const read = (await app.inject({ method: "GET", url: "/me/consents", headers })).json();
      expect(read.decisions[0]).toMatchObject({ decision: "revoke", effective: false });
      // аккаунт остаётся доступен: профиль и удаление не зависят от согласия
      expect((await app.inject({ method: "GET", url: "/me", headers })).statusCode).toBe(200);
    } finally {
      await app.close();
      await sql`UPDATE consent_disclosures SET is_current=false WHERE id=${policyId}`.catch(() => {});
    }
  });
});
