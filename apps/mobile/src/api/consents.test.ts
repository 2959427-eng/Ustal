import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeConsent } from "./consents";
import { consentRequest, type ConsentSnapshot } from "../lib/ai-consent";
const request = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ apiClient: { request } }));
const snapshot = (): ConsentSnapshot => ({ revision: 7, aiConsentPurpose: "ai", outboundEnforcement: true, policies: [{ id: "current", purpose: "ai", version: "2", policyHash: "hash2", status: "approved", content: { humanText: "Полные утверждённые условия" } }], decisions: [] });
beforeEach(() => { request.mockReset(); });
describe("existing consent registry contract", () => {
  it("refuses missing or unrelated configured purpose", () => {
    const s = snapshot(); s.aiConsentPurpose = null; expect(() => consentRequest(s, "ai", "grant")).toThrow();
    s.aiConsentPurpose = "other"; expect(() => consentRequest(s, "ai", "grant")).toThrow();
  });
  it("uses server policy/hash/revision, no local consent", async () => {
    request.mockResolvedValue({ changed: true, revision: 8 });
    await changeConsent(snapshot(), "ai", "grant");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ policyId: "current", policyHash: "hash2", expectedRevision: 7, decision: "grant" });
  });
  it("blocks off-mode grants but permits revoking an existing grant", async () => {
    const s = snapshot(); s.outboundEnforcement = false;
    await expect(changeConsent(s, "ai", "grant")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    s.decisions = [{ purpose: "ai", policyId: "old", policyHash: "hash1", decision: "grant", effective: false }];
    request.mockResolvedValue({ changed: true, revision: 8 });
    await changeConsent(s, "ai", "revoke");
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ decision: "revoke", policyId: "old" });
  });
  it("refuses unavailable/draft/TBD policy", () => {
    const s = snapshot(); s.policies[0].content.humanText = "[DATA_RETENTION_TBD]";
    expect(() => consentRequest(s, "ai", "grant")).toThrow();
    s.policies[0].content.humanText = "Текст"; s.policies[0].status = "draft";
    expect(() => consentRequest(s, "ai", "grant")).toThrow();
    s.policies = []; expect(() => consentRequest(s, "ai", "grant")).toThrow();
  });
  it("revokes an older grant even after its policy is replaced or removed", () => {
    const s = snapshot(); s.decisions = [{ purpose: "ai", policyId: "old", policyHash: "hash1", decision: "grant", effective: false }];
    s.policies = [];
    expect(consentRequest(s, "ai", "revoke")).toEqual({ policyId: "old", policyHash: "hash1", expectedRevision: 7, decision: "revoke" });
  });
  it("blocks concurrent submits and releases the lock on failure", async () => {
    let reject!: (e: Error) => void;
    request.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const first = changeConsent(snapshot(), "ai", "grant");
    await expect(changeConsent(snapshot(), "ai", "grant")).rejects.toThrow("уже выполняется");
    reject(new Error("offline")); await expect(first).rejects.toThrow("offline");
    request.mockResolvedValue({ changed: true, revision: 8 });
    await expect(changeConsent(snapshot(), "ai", "grant")).resolves.toMatchObject({ revision: 8 });
  });
  it("propagates stale revision instead of silently resubmitting", async () => {
    request.mockRejectedValue(new Error("consent_revision_conflict"));
    await expect(changeConsent(snapshot(), "ai", "grant")).rejects.toThrow("consent_revision_conflict");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
