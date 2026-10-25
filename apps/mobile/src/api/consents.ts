import { ApiRequestError } from "@ustal/api-client";
import { aiConsentState, consentDecisionBody, type AiConsentState, type ConsentsResponse } from "../lib/ai-consent-state";
import { apiClient } from "./client";
import { consentRequest, type ConsentSnapshot } from "../lib/ai-consent";
export const getConsents = () => apiClient.request<ConsentSnapshot>("/me/consents");
let changing = false;
export async function changeConsent(snapshot: ConsentSnapshot, purpose: string, decision: "grant" | "revoke") {
  if (changing) throw new Error("Изменение согласия уже выполняется");
  changing = true;
  try { return await apiClient.request<{ changed: boolean; revision: number }>("/me/consents", { method: "POST", body: JSON.stringify(consentRequest(snapshot, purpose, decision)) }); }
  finally { changing = false; }
}

export async function getAiConsent(): Promise<AiConsentState> {
  try {
    return aiConsentState(await apiClient.request<ConsentsResponse>("/me/consents"));
  } catch (error) {
    // Маршрут не зарегистрирован (режим off) — согласие сервером не требуется и данные не ограничены этим механизмом.
    if (error instanceof ApiRequestError && error.status === 404) return { kind: "not_required" };
    throw error;
  }
}

export async function decideAiConsent(state: Extract<AiConsentState, { kind: "required" }>, decision: "grant" | "revoke") {
  return apiClient.request<{ changed: boolean; revision: number }>("/me/consents", {
    method: "POST",
    body: JSON.stringify(consentDecisionBody(state, decision)),
  });
}
