import { ApiRequestError } from "@ustal/api-client";
import { apiClient } from "./client";
import { aiConsentState, consentDecisionBody, type AiConsentState, type ConsentsResponse } from "../lib/ai-consent";

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
