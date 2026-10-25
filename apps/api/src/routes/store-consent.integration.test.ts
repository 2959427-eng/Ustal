import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql } from "@ustal/database";
import { buildApp } from "../app.js";

assertLocalTestDatabase();
const sql = getSql();
const cityId = randomUUID();
let sequence = 0;
const payload = () => ({ name: "Local integration fixture", phone: `+7001${String(++sequence).padStart(7, "0")}`,
  password: "fixture-password-only", cityId, acceptedRules: true, acceptedPdn: true });
async function appFor(mode: "compatibility" | "required") {
  vi.stubEnv("USTAL_REGISTRATION_AGE_MODE", mode);
  vi.stubEnv("USTAL_AI_CONSENT_MODE", "off");
  return buildApp();
}
beforeAll(async () => {
  await sql`INSERT INTO cities(id,name,region_name,federal_district,timezone) VALUES(${cityId},'Fixture','Fixture','Fixture','UTC')`;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await sql.end(); });

describe("combined store/age/consent rollout", () => {
  it("compatibility preserves legacy registration without inventing age or AI consent", async () => {
    const app = await appFor("compatibility");
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: payload() });
      expect(r.statusCode).toBe(201);
      const user = r.json();
      const [evidence] = await sql`SELECT count(*)::int n FROM audit_logs WHERE actor_id=${user.userId} AND action='registration_age_confirmed'`;
      expect(evidence!.n).toBe(0);
      const headers = { authorization: `Bearer ${user.accessToken}` };
      const status = await app.inject({ method: "GET", url: "/me/consents", headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ outboundEnforcement: false, revision: 0, decisions: [] });
      const legal = await app.inject("/privacy");
      expect(legal.statusCode).toBe(200); // Local preview; the production gate is covered by legal.test.ts.
      expect(legal.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    } finally { await app.close(); }
  });
  it.each([undefined, false, "true", 1])("required rejects missing/nonboolean declaration %s before creating a user", async acceptedAge18 => {
    const app = await appFor("required"); const body = { ...payload(), acceptedAge18 };
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: body });
      expect(r.statusCode).toBe(400); expect(r.json().error.code).toBe("age_confirmation_required");
      const [users] = await sql`SELECT count(*)::int n FROM users WHERE phone=${body.phone}`;
      expect(users!.n).toBe(0);
    } finally { await app.close(); }
  });
  it("compatibility rollout records an explicit declaration from a new client", async () => {
    const app = await appFor("compatibility");
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: { ...payload(), acceptedAge18: true } });
      expect(r.statusCode).toBe(201);
      const rows = await sql`SELECT metadata FROM audit_logs WHERE actor_id=${r.json().userId} AND action='registration_age_confirmed'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({ method: "self_declaration", enforcementMode: "compatibility" });
    } finally { await app.close(); }
  });
  it("required records only an explicit self-declaration, atomically with registration", async () => {
    const app = await appFor("required");
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: { ...payload(), acceptedAge18: true } });
      expect(r.statusCode).toBe(201); const user = r.json();
      const rows = await sql`SELECT metadata FROM audit_logs WHERE actor_id=${user.userId} AND action='registration_age_confirmed'`;
      expect(rows).toHaveLength(1); expect(rows[0]!.metadata).toMatchObject({ policy: "18+", method: "self_declaration", enforcementMode: "required" });
      const [grants] = await sql`SELECT count(*)::int n FROM consent_decisions WHERE user_id=${user.userId}`;
      expect(grants!.n).toBe(0);
      const broken = { ...payload(), cityId: randomUUID(), acceptedAge18: true };
      expect((await app.inject({ method: "POST", url: "/auth/register", payload: broken })).statusCode).toBe(500);
      const [left] = await sql`SELECT count(*)::int n FROM users WHERE phone=${broken.phone}`;
      expect(left!.n).toBe(0);
    } finally { await app.close(); }
  });
  it("required mode does not gate legacy login, refresh, profile reads or account deletion", async () => {
    let app = await appFor("compatibility"); const body = payload();
    const registered = await app.inject({ method: "POST", url: "/auth/register", payload: body });
    expect(registered.statusCode).toBe(201); await app.close(); app = await appFor("required");
    try {
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { phone: body.phone, password: body.password } });
      expect(login.statusCode).toBe(200);
      const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken } });
      expect(refreshed.statusCode).toBe(200);
      const headers = { authorization: `Bearer ${refreshed.json().accessToken}` };
      expect((await app.inject({ method: "GET", url: "/profile", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: "/me", headers, payload: { password: body.password } })).statusCode).toBe(204);
    } finally { await app.close(); }
  });
});
