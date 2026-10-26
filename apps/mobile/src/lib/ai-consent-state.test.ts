import { describe, expect, it } from "vitest";
import { aiConsentState, consentDecisionBody, shouldPromptAiConsent, type ConsentsResponse } from "./ai-consent-state";
import { AI_CONSENT_TEXT } from "./ai-consent-flow";
import { registrationConsentError, registrationDocumentsReady } from "./registration-consent";

const policy = { id: "p2", purpose: "ustal_ai_processing", version: "2", content: { humanText: "Текст согласия", notice: [...AI_CONSENT_TEXT], aiDispatch: {} }, policyHash: "h2", status: "approved" };
const res = (over: Partial<ConsentsResponse> = {}): ConsentsResponse => ({ revision: 3, policies: [policy], decisions: [], outboundEnforcement: true, aiConsentPurpose: policy.purpose, ...over });
const decision = (d: "grant" | "revoke", policyId = "p2", policyHash = "h2", effective = d === "grant") =>
  ({ purpose: "ustal_ai_processing", policyId, policyHash, decision: d, seq: 3, decidedAt: "2026-10-25T00:00:00Z", effective });

describe("состояние согласия на ИИ", () => {
  it("режим off (нет маршрута / outboundEnforcement=false) — не требуется, не спрашиваем", () => {
    expect(aiConsentState(null)).toEqual({ kind: "not_required" });
    expect(aiConsentState(res({ outboundEnforcement: false }))).toEqual({ kind: "not_required" });
    expect(shouldPromptAiConsent(aiConsentState(null))).toBe(false);
  });
  it("нет утверждённого текста — согласие дать нельзя (unavailable)", () => {
    expect(aiConsentState(res({ policies: [{ ...policy, status: "draft" }] })).kind).toBe("unavailable");
    expect(aiConsentState(res({ policies: [{ ...policy, content: {} }] })).kind).toBe("unavailable");
  });
  it("нет решения — спрашиваем", () => {
    const s = aiConsentState(res());
    expect(s).toMatchObject({ kind: "required", status: "undecided", text: "Текст согласия" });
    expect(shouldPromptAiConsent(s)).toBe(true);
  });
  it("согласие на текущую версию — granted, не спрашиваем", () => {
    const s = aiConsentState(res({ decisions: [decision("grant")] }));
    expect(s).toMatchObject({ status: "granted" });
    expect(shouldPromptAiConsent(s)).toBe(false);
  });
  it("отказ/отзыв — refused, повторно не навязываем", () => {
    const s = aiConsentState(res({ decisions: [decision("revoke")] }));
    expect(s).toMatchObject({ status: "refused" });
    expect(shouldPromptAiConsent(s)).toBe(false);
  });
  it("согласие на прежнюю версию текста не действует — outdated, спрашиваем снова", () => {
    for (const d of [decision("grant", "p1", "h1"), decision("grant", "p2", "h2", false)]) {
      const s = aiConsentState(res({ decisions: [d] }));
      expect(s).toMatchObject({ status: "outdated" });
      expect(shouldPromptAiConsent(s)).toBe(true);
    }
  });
  it("тело решения — ровно версия показанного текста и текущая ревизия", () => {
    const s = aiConsentState(res());
    if (s.kind !== "required") throw new Error("expected required");
    expect(consentDecisionBody(s, "grant")).toEqual({ policyId: "p2", policyHash: "h2", policyVersion: "2", notice: [...AI_CONSENT_TEXT], decision: "grant", expectedRevision: 3 });
    expect(consentDecisionBody(s, "revoke")).toEqual({ policyId: "p2", policyHash: "h2", policyVersion: "2", decision: "revoke", expectedRevision: 3 });
  });
  it("grant, deny и revoke относятся к настроенному purpose, независимо от порядка других approved policy", () => {
    const other = { ...policy, id: "other", purpose: "aaa_other", policyHash: "other-hash" };
    for (const policies of [[other, policy], [policy, other]]) {
      const s = aiConsentState(res({ policies }));
      expect(s).toMatchObject({ kind: "required", policy, status: "undecided" });
      if (s.kind !== "required") throw new Error("expected required");
      for (const action of ["grant", "revoke"] as const)
        expect(consentDecisionBody(s, action)).toMatchObject({ policyId: policy.id, policyHash: policy.policyHash, policyVersion: policy.version, decision: action, expectedRevision: 3 });
      const unrelated = { ...decision("grant"), purpose: other.purpose, policyId: other.id, policyHash: other.policyHash };
      expect(aiConsentState(res({ policies, decisions: [unrelated, decision("revoke")] }))).toMatchObject({ status: "refused" });
      expect(aiConsentState(res({ policies, decisions: [{ ...unrelated, decision: "revoke" }, decision("grant")] }))).toMatchObject({ status: "granted" });
      expect(aiConsentState(res({ policies, decisions: [unrelated, decision("grant", "p1", "h1", false)] }))).toMatchObject({ status: "outdated" });
    }
  });
  it("нет purpose в старом API, неизвестный purpose или только посторонняя policy — unavailable, не ложный grant", () => {
    for (const aiConsentPurpose of [undefined, null, "", "unknown-purpose"])
      expect(aiConsentState(res({ aiConsentPurpose, decisions: [decision("grant")] })).kind).toBe("unavailable");
    expect(aiConsentState(res({ policies: [{ ...policy, purpose: "other" }] })).kind).toBe("unavailable");
  });
  it("purpose не захардкожен в клиенте", () => {
    const custom = { ...policy, purpose: "configured_ai_v2" };
    expect(aiConsentState(res({ aiConsentPurpose: custom.purpose, policies: [policy, custom] })))
      .toMatchObject({ kind: "required", policy: custom });
  });
});

describe("согласия при регистрации", () => {
  const ok = { acceptedRules: true, acceptedPdn: true, documentsReady: true, allowUnpublished: false };
  it("без любой из отметок регистрация не отправляется", () => {
    expect(registrationConsentError({ ...ok, acceptedRules: false })).toMatch(/соглашение/);
    expect(registrationConsentError({ ...ok, acceptedPdn: false })).toMatch(/персональных/);
    expect(registrationConsentError(ok)).toBeNull();
  });
  it("неопубликованные документы блокируют регистрацию вне сборки разработчика", () => {
    expect(registrationConsentError({ ...ok, documentsReady: false })).toMatch(/не опубликованы/);
    expect(registrationConsentError({ ...ok, documentsReady: false, allowUnpublished: true })).toBeNull();
    expect(registrationConsentError({ ...ok, documentsReady: false, allowUnpublished: true, acceptedPdn: false })).not.toBeNull();
  });
  it("готовность документов — нужны и политика, и соглашение", () => {
    const d = (id: "privacy" | "terms" | "ai-processing", available: boolean) => ({ id, available, version: available ? "2026-11-01" : null, path: `/legal/${id}` });
    expect(registrationDocumentsReady([d("privacy", true), d("terms", true), d("ai-processing", false)])).toBe(true);
    expect(registrationDocumentsReady([d("privacy", true), d("terms", false)])).toBe(false);
    expect(registrationDocumentsReady([])).toBe(false);
  });
});

describe("уведомление политики привязано к утверждённому тексту окна", () => {
  it("текст совпадает дословно — можно спрашивать; любое отличие, лишний/недостающий абзац или нет уведомления — grant невозможен", () => {
    expect(aiConsentState(res())).toMatchObject({ kind: "required", status: "undecided" });
    const variants: unknown[] = [undefined, [], AI_CONSENT_TEXT.slice(0, 3), [...AI_CONSENT_TEXT, "ещё"],
      [AI_CONSENT_TEXT[0] + " ", ...AI_CONSENT_TEXT.slice(1)], [AI_CONSENT_TEXT[0].replace("OpenAI", "другой ИИ"), ...AI_CONSENT_TEXT.slice(1)], AI_CONSENT_TEXT.join("\n\n")];
    for (const notice of variants)
      expect(aiConsentState(res({ policies: [{ ...policy, content: { ...policy.content, notice } }] })))
        .toEqual({ kind: "unavailable", reason: "notice_mismatch" });
  });
  it("несовпадение не скрывает отзыв ранее выданного разрешения", () => {
    const grant = { purpose: policy.purpose, policyId: "p1", policyHash: "h1", decision: "grant" as const, seq: 2, decidedAt: "2026-10-20T00:00:00Z", effective: false };
    expect(aiConsentState(res({ policies: [{ ...policy, content: { humanText: "Текст согласия" } }], decisions: [grant] })))
      .toEqual({ kind: "unavailable", reason: "notice_mismatch", revocable: [{ purpose: policy.purpose, policyId: "p1", policyHash: "h1", revision: 3 }] });
  });
});
