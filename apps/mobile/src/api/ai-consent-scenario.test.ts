import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@ustal/api-client";
import { checkAiAction, decideAiConsent, getAiConsent } from "./consents";
import { AI_CONSENT_TEXT, CONSENT_FOR_PROFILE_ROUTE, PROFILE_FILL_ROUTE, afterAiConsentRoute, aiBlockedRoute, postRegistrationRoute } from "../lib/ai-consent-flow";
import { aiActionGate, shouldPromptAiConsent, type ConsentsResponse } from "../lib/ai-consent-state";

const request = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ apiClient: { request }, currentApiSession: () => 0 }));

const policy = (version = "1", hash = "hash1", id = "p1") =>
  ({ id, purpose: "ai", version, policyHash: hash, status: "approved", content: { humanText: "Полные условия", notice: [...AI_CONSENT_TEXT] } });
const decision = (d: "grant" | "revoke", p = policy(), seq = 1, effective = d === "grant") =>
  ({ purpose: "ai", policyId: p.id, policyHash: p.policyHash, decision: d, seq, decidedAt: "2026-10-26T00:00:00Z", effective });
const server = (over: Partial<ConsentsResponse> = {}): ConsentsResponse =>
  ({ revision: 0, aiConsentPurpose: "ai", outboundEnforcement: true, policies: [policy()], decisions: [], ...over });
const posts = () => request.mock.calls.filter((c) => c[1]?.method === "POST");
beforeEach(() => { request.mockReset(); });

describe("регистрация → профиль: окно согласия перед первой ИИ-обработкой (enforced)", () => {
  it("после регистрации окна нет; при первом заполнении профиля — окно; разрешение → обратно в профиль, обработка разрешена", async () => {
    expect(postRegistrationRoute(null)).toBe("/(tabs)");

    request.mockResolvedValueOnce(server());
    const first = await checkAiAction();
    expect(first).toMatchObject({ ok: false, gate: "ask" });
    expect(aiBlockedRoute(first, "profile")).toBe(CONSENT_FOR_PROFILE_ROUTE);
    expect(posts()).toHaveLength(0); // профиль в OpenAI не ушёл

    request.mockResolvedValueOnce(server());
    const shown = await getAiConsent();
    if (shown.kind !== "required") throw new Error("required expected");
    request.mockResolvedValueOnce(server()).mockResolvedValueOnce({ changed: true, revision: 1 });
    await decideAiConsent(shown, "grant");
    expect(JSON.parse(posts()[0]![1].body)).toMatchObject({ decision: "grant", policyId: "p1", policyHash: "hash1", policyVersion: "1", notice: [...AI_CONSENT_TEXT] });
    expect(afterAiConsentRoute({ onboarding: false, next: CONSENT_FOR_PROFILE_ROUTE.params.next })).toBe(PROFILE_FILL_ROUTE);

    request.mockResolvedValueOnce(server({ revision: 1, decisions: [decision("grant")] }));
    expect(await checkAiAction()).toEqual({ ok: true });
  });

  it("отказ: обработка заблокирована, окно больше не навязывается, навигация обычная; согласиться можно позже", async () => {
    request.mockResolvedValueOnce(server());
    const shown = await getAiConsent();
    if (shown.kind !== "required") throw new Error("required expected");
    request.mockResolvedValueOnce({ changed: true, revision: 1 });
    await decideAiConsent(shown, "revoke");
    expect(JSON.parse(posts()[0]![1].body)).toMatchObject({ decision: "revoke", policyVersion: "1" });

    const refused = server({ revision: 1, decisions: [decision("revoke")] });
    request.mockResolvedValueOnce(refused);
    const check = await checkAiAction();
    expect(check).toMatchObject({ ok: false, gate: "blocked" });
    expect(aiBlockedRoute(check, "profile")).toBeNull(); // остаёмся в профиле с сообщением, без окна
    expect(aiBlockedRoute(check, "other")).toBe(PROFILE_FILL_ROUTE); // заказ → к профилю
    expect(afterAiConsentRoute({ onboarding: false, next: PROFILE_FILL_ROUTE })).toBe(PROFILE_FILL_ROUTE);

    request.mockResolvedValueOnce(refused);
    const later = await getAiConsent();
    expect(shouldPromptAiConsent(later)).toBe(false);
    if (later.kind !== "required") throw new Error("required expected");
    request.mockResolvedValueOnce(refused).mockResolvedValueOnce({ changed: true, revision: 2 });
    await expect(decideAiConsent(later, "grant")).resolves.toEqual({ changed: true, revision: 2 });
    expect(posts()).toHaveLength(2);
  });

  it("повторно не спрашиваем после решения; новая утверждённая версия условий — спрашиваем снова перед обработкой", async () => {
    request.mockResolvedValueOnce(server({ revision: 1, decisions: [decision("grant")] }));
    expect(await checkAiAction()).toEqual({ ok: true });
    request.mockResolvedValueOnce(server({ revision: 1, decisions: [decision("revoke")] }));
    expect(await checkAiAction()).toMatchObject({ gate: "blocked" });
    const v2 = policy("2", "hash2", "p2");
    request.mockResolvedValueOnce(server({ revision: 1, policies: [v2], decisions: [decision("grant", policy(), 1, false)] }));
    expect(await checkAiAction()).toMatchObject({ ok: false, gate: "ask" });
  });

  it("ИИ-действие до согласия, без утверждённых условий или при ошибке проверки — ничего не отправляется", async () => {
    for (const res of [server(), server({ policies: [] }), server({ policies: [{ ...policy(), content: { humanText: "Другие условия", notice: ["Другой текст"] } }] })]) {
      request.mockReset();
      request.mockResolvedValueOnce(res);
      const check = await checkAiAction();
      expect(check.ok).toBe(false);
      expect(posts()).toHaveLength(0);
    }
    request.mockRejectedValueOnce(new ApiRequestError("offline", 503));
    expect(await checkAiAction()).toMatchObject({ ok: false, gate: "unknown" });
  });

  it("режим off и старый сервер: окна нет, интерфейс не блокирует — защиты в off нет, её даёт только enforced на сервере", async () => {
    request.mockResolvedValueOnce(server({ outboundEnforcement: false }));
    expect(await checkAiAction()).toEqual({ ok: true });
    request.mockRejectedValueOnce(new ApiRequestError("not found", 404));
    expect(await checkAiAction()).toEqual({ ok: true });
    expect(aiActionGate({ kind: "not_required" })).toBe("allow");
  });
});
