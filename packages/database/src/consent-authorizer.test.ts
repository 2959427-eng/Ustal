import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ calls: [] as { sql: string; values: unknown[] }[], rows: [] as unknown[],
  error: null as Error | null, pending: false, cancelled: vi.fn(), options: {} as any }));
vi.mock("./env.js", () => ({ loadDatabaseUrl: () => "postgres://fixture:fixture@127.0.0.1/fixture_test" }));
vi.mock("postgres", () => ({ default: (_url: string, options: any) => {
  fake.options = options;
  const tag = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    fake.calls.push({ sql: strings.join("?"), values });
    const result = fake.pending ? new Promise(() => {}) : fake.error ? Promise.reject(fake.error) : Promise.resolve(fake.rows);
    return Object.assign(result, { cancel: fake.cancelled });
  }, { json: (ids: unknown) => ids, end: async () => {} });
  return tag;
} }));
import { createConsentBatchAuthorizer, closeConsentAuthorizationPool, disclosureHash, ConsentAuthorizationUnavailable } from "./consents.js";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const actual = { provider: "openai", endpoint: "https://fixture.invalid/v1", recipientBinding: "a".repeat(64) };
const content = { humanText: "TEST ONLY synthetic approved content", aiDispatch: { schemaVersion: 1, purpose: "ai-processing",
  recipients: [{ name: "TEST ONLY recipient", ...actual }] } };
const publication = { approved: true as const, policyId: "33333333-3333-4333-8333-333333333333", purpose: "ai-processing", policyHash: disclosureHash(content), ...actual };
const input = { subjectUserIds: ids, publication, operation: "test", traceId: "fixture" };
beforeEach(() => {
  fake.calls = []; fake.error = null; fake.pending = false; fake.cancelled.mockReset();
  fake.rows = ids.map(user_id => ({ user_id, user_status: "active", publication_id: publication.policyId, purpose: publication.purpose,
    content, content_hash: publication.policyHash, publication_status: "approved", is_current: true,
    policy_id: publication.policyId, policy_hash: publication.policyHash, decision: "grant", current_revision: 9 }));
});
afterEach(async () => { await closeConsentAuthorizationPool(); vi.useRealTimers(); });
describe("atomic query contract, fake transport only (not real PostgreSQL evidence)", () => {
  it("uses exactly ONE dedicated-pool statement for all identities/publication/latest decision/revision", async () => {
    expect(await createConsentBatchAuthorizer(actual)({ ...input, subjectUserIds: [ids[1]!, ids[0]!, ids[1]!] })).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const query = fake.calls[0]!;
    expect(query.sql).toContain("jsonb_array_elements_text"); expect(query.sql).toContain("ORDER BY d.seq DESC LIMIT 1");
    expect(query.sql).toContain("max(seq)"); expect(query.sql).not.toMatch(/BEGIN|FOR UPDATE/);
    expect(query.sql).toContain("::text::jsonb");
    const subjects = query.values.filter(value => typeof value === "string" && value.startsWith("["));
    expect(subjects).toHaveLength(1);
    expect(JSON.parse(subjects[0] as string)).toEqual(ids);
    expect(fake.options.max).toBe(2); expect(fake.options.connect_timeout).toBe(2);
    expect(fake.options.connection.statement_timeout).toBe(2000);
    fake.rows = (fake.rows as any[]).map(row => ({ ...row, decision: "revoke" }));
    expect(await createConsentBatchAuthorizer(actual)(input)).toBe(false); expect(fake.calls).toHaveLength(2);
  });
  it("checks stored JSON hash and exact one recipient, not just caller-provided strings", async () => {
    fake.rows = (fake.rows as any[]).map(row => ({ ...row, content: { ...content, humanText: "different" } }));
    expect(await createConsentBatchAuthorizer(actual)(input)).toBe(false);
  });
  it.each(["[AGE_POLICY_TBD]", "[LAUNCH_TERRITORIES_TBD]", "[DATA_RETENTION_TBD]", "[BACKUP_RETENTION_TBD]"])("never accepts approved JSON containing unresolved marker %s", async marker => {
    const changed = { ...content, humanText: `TEST ONLY synthetic disclosure ${marker}` }, hash = disclosureHash(changed);
    fake.rows = (fake.rows as any[]).map(row => ({ ...row, content: changed, content_hash: hash, policy_hash: hash }));
    expect(await createConsentBatchAuthorizer(actual)({ ...input, publication: { ...publication, policyHash: hash } })).toBe(false);
  });
  it.each(["duplicate", "bad_endpoint", "wrong_schema"])("fails closed for malformed approved recipient section: %s", async kind => {
    const changed = structuredClone(content);
    if (kind === "duplicate") changed.aiDispatch.recipients.push(changed.aiDispatch.recipients[0]!);
    if (kind === "bad_endpoint") changed.aiDispatch.recipients.push({ ...actual, name: "Other", endpoint: "TBD" });
    if (kind === "wrong_schema") changed.aiDispatch.schemaVersion = 2;
    const hash = disclosureHash(changed);
    fake.rows = (fake.rows as any[]).map(row => ({ ...row, content: changed, content_hash: hash, policy_hash: hash }));
    expect(await createConsentBatchAuthorizer(actual)({ ...input, publication: { ...publication, policyHash: hash } })).toBe(false);
  });
  it("does not queue an unbounded permission lookup when both dedicated admissions are occupied", async () => {
    vi.useFakeTimers(); fake.pending = true;
    const authorize = createConsentBatchAuthorizer(actual);
    const first = authorize(input).catch(e => e), second = authorize(input).catch(e => e);
    expect(await authorize(input).catch(e => e)).toBeInstanceOf(ConsentAuthorizationUnavailable);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3001);
    for (const error of await Promise.all([first, second])) expect(error).toBeInstanceOf(ConsentAuthorizationUnavailable);
  });
  it("sanitizes DB failure and caps a hung transport at three seconds", async () => {
    fake.error = Error("SECRET SQL postgres://credential");
    const first = await createConsentBatchAuthorizer(actual)(input).catch(e => e);
    expect(first).toBeInstanceOf(ConsentAuthorizationUnavailable); expect(String(first)).not.toMatch(/SECRET|SQL|credential/);
    fake.error = null; fake.pending = true; vi.useFakeTimers();
    const waiting = createConsentBatchAuthorizer(actual)(input).catch(e => e);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await waiting).toBeInstanceOf(ConsentAuthorizationUnavailable); expect(fake.cancelled).toHaveBeenCalledTimes(1);
  });
});
