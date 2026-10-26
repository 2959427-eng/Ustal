import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@ustal/api-client";
import { AiConsentChangedError, aiConsentErrorMessage, decideAiConsent, getAiConsent, revokeAiConsentGrant } from "./consents";
import { AI_CONSENT_TEXT } from "../lib/ai-consent-flow";
import type { ConsentsResponse } from "../lib/ai-consent-state";

const request = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ apiClient: { request } }));

const policy = { id: "current", purpose: "ai", version: "2", policyHash: "hash2", status: "approved", content: { humanText: "Полные утверждённые условия", notice: [...AI_CONSENT_TEXT] } };
const response = (over: Partial<ConsentsResponse> = {}): ConsentsResponse =>
  ({ revision: 7, aiConsentPurpose: "ai", outboundEnforcement: true, policies: [policy], decisions: [], ...over });
const required = async (over: Partial<ConsentsResponse> = {}) => {
  request.mockResolvedValueOnce(response(over));
  const s = await getAiConsent();
  if (s.kind !== "required") throw new Error(`expected required, got ${s.kind}`);
  return s;
};
beforeEach(() => { request.mockReset(); });

describe("единый контракт согласия на ИИ (GET/POST /me/consents)", () => {
  it("purpose задаёт сервер: без него или с чужим purpose согласие дать нельзя", async () => {
    request.mockResolvedValueOnce(response({ aiConsentPurpose: null }));
    expect((await getAiConsent()).kind).toBe("unavailable");
    request.mockResolvedValueOnce(response({ aiConsentPurpose: "other" }));
    expect((await getAiConsent()).kind).toBe("unavailable");
  });

  it("сервер без контроля (off / старый API 404) — согласие не требуется и не отправляется", async () => {
    request.mockResolvedValueOnce(response({ outboundEnforcement: false }));
    expect(await getAiConsent()).toEqual({ kind: "not_required" });
    request.mockRejectedValueOnce(new ApiRequestError("not found", 404));
    expect(await getAiConsent()).toEqual({ kind: "not_required" });
  });

  it("черновик/шаблон/непроверенный текст не превращается в условия для согласия", async () => {
    for (const humanText of ["[DATA_RETENTION_TBD]", "ПРОЕКТ текста", "[УКАЗАТЬ оператора]", "  "]) {
      request.mockResolvedValueOnce(response({ policies: [{ ...policy, content: { humanText } }] }));
      expect((await getAiConsent()).kind).toBe("unavailable");
    }
    request.mockResolvedValueOnce(response({ policies: [{ ...policy, status: "draft" }] }));
    expect((await getAiConsent()).kind).toBe("unavailable");
  });

  it("«Разрешаю» сверяет условия с сервером и отправляет ровно показанные версию, хеш, текст и ревизию", async () => {
    const s = await required();
    request.mockResolvedValueOnce(response()).mockResolvedValueOnce({ changed: true, revision: 8 });
    await decideAiConsent(s, "grant");
    expect(request.mock.calls[1]).toEqual(["/me/consents"]);
    expect(request.mock.calls[2][0]).toBe("/me/consents");
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ policyId: "current", policyHash: "hash2", policyVersion: "2", notice: [...AI_CONSENT_TEXT], expectedRevision: 7, decision: "grant" });
  });

  it("«Не разрешаю» записывается как revoke той же версии — отказ сохраняется с версией и временем на сервере", async () => {
    const s = await required();
    request.mockResolvedValueOnce({ changed: true, revision: 8 });
    await decideAiConsent(s, "revoke");
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ policyId: "current", policyHash: "hash2", policyVersion: "2", expectedRevision: 7, decision: "revoke" });
    expect(request).toHaveBeenCalledTimes(2); // отказ не требует повторной сверки и не несёт текст
  });

  it("двойное нажатие не отправляет два решения; после ошибки можно повторить", async () => {
    const s = await required();
    let reject!: (e: Error) => void;
    request.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const first = decideAiConsent(s, "revoke");
    await expect(decideAiConsent(s, "revoke")).rejects.toThrow("уже отправляется");
    reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    request.mockResolvedValueOnce(response()).mockResolvedValueOnce({ changed: true, revision: 8 });
    await expect(decideAiConsent(s, "grant")).resolves.toMatchObject({ revision: 8 });
    const posts = request.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(2);
  });

  it("устаревшая ревизия (409) не переотправляется молча", async () => {
    const s = await required();
    request.mockResolvedValueOnce(response()).mockRejectedValueOnce(new ApiRequestError("conflict", 409, "consent_revision_conflict"));
    const err = await decideAiConsent(s, "grant").catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(aiConsentErrorMessage(err)).toMatch(/Разрешение не отправлено/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("режим off: ранее выданное разрешение можно отозвать, отзыв уходит на сервер по его собственной версии", async () => {
    const grant = { purpose: "ai", policyId: "old", policyHash: "hash1", decision: "grant" as const, seq: 3, decidedAt: "2026-10-20T00:00:00Z", effective: false };
    request.mockResolvedValueOnce(response({ outboundEnforcement: false, policies: [], decisions: [grant] }));
    const s = await getAiConsent();
    expect(s).toEqual({ kind: "not_required", revocable: [{ purpose: "ai", policyId: "old", policyHash: "hash1", revision: 7 }] });
    if (s.kind !== "not_required" || !s.revocable) throw new Error("revocable expected");
    request.mockResolvedValueOnce({ changed: true, revision: 8 });
    await revokeAiConsentGrant(s.revocable[0]!);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ policyId: "old", policyHash: "hash1", decision: "revoke", expectedRevision: 7 });
  });

  it("режим off: после отзыва (последнее решение revoke) и без решений отзывать нечего; grant в off не предлагается", async () => {
    const d = (decision: "grant" | "revoke", seq: number) => ({ purpose: "ai", policyId: "current", policyHash: "hash2", decision, seq, decidedAt: "2026-10-20T00:00:00Z", effective: false });
    request.mockResolvedValueOnce(response({ outboundEnforcement: false, decisions: [d("revoke", 4), d("grant", 3)] }));
    expect(await getAiConsent()).toEqual({ kind: "not_required" });
    request.mockResolvedValueOnce(response({ outboundEnforcement: false }));
    expect(await getAiConsent()).toEqual({ kind: "not_required" });
  });

  it("enforced без утверждённых условий: старое разрешение всё равно можно отозвать", async () => {
    const grant = { purpose: "ai", policyId: "old", policyHash: "hash1", decision: "grant" as const, seq: 3, decidedAt: "2026-10-20T00:00:00Z", effective: false };
    request.mockResolvedValueOnce(response({ policies: [], decisions: [grant] }));
    expect(await getAiConsent()).toMatchObject({ kind: "unavailable", revocable: [{ policyId: "old" }] });
  });

  it("условия изменились, пока пользователь читал (версия/хеш/политика/ревизия): grant не отправляется", async () => {
    for (const fresh of [response({ policies: [{ ...policy, version: "3" }] }), response({ policies: [{ ...policy, policyHash: "hash3" }] }),
      response({ policies: [{ ...policy, id: "next" }] }), response({ policies: [] }), response({ revision: 8 }),
      response({ policies: [{ ...policy, content: { ...policy.content, notice: ["Другой текст"] } }] })]) {
      request.mockReset();
      const s = await required();
      request.mockResolvedValueOnce(fresh);
      await expect(decideAiConsent(s, "grant")).rejects.toBeInstanceOf(AiConsentChangedError);
      expect(request.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
    }
  });

  it("сервер отклонил grant (текст/версия не совпали, политика сменилась) — понятная ошибка, без переотправки", async () => {
    for (const code of ["consent_notice_mismatch", "consent_policy_changed", "consent_policy_not_approved_current"]) {
      request.mockReset();
      const s = await required();
      request.mockResolvedValueOnce(response()).mockRejectedValueOnce(new ApiRequestError("conflict", 409, code));
      const err = await decideAiConsent(s, "grant").catch((e) => e);
      expect(aiConsentErrorMessage(err)).toMatch(/данные в OpenAI не передаются/);
      expect(request.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    }
    expect(aiConsentErrorMessage(new Error("offline"))).toBe("Решение не сохранено. Обновите экран и попробуйте ещё раз.");
  });

  it("повторный «Разрешаю» по уже выданной версии — сервер отвечает no-op, лишнего решения нет", async () => {
    const granted = { purpose: "ai", policyId: "current", policyHash: "hash2", decision: "grant" as const, seq: 7, decidedAt: "2026-10-26T00:00:00Z", effective: true };
    const s = await required({ decisions: [granted] });
    expect(s.status).toBe("granted");
    request.mockResolvedValueOnce(response({ decisions: [granted] })).mockResolvedValueOnce({ changed: false, revision: 7 });
    await expect(decideAiConsent(s, "grant")).resolves.toEqual({ changed: false, revision: 7 });
  });
});
