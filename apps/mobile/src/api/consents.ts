import { ApiRequestError } from "@ustal/api-client";
import { aiConsentState, consentDecisionBody, noticeMatches, samePolicy, revokeGrantBody, type AiConsentState, type ConsentsResponse, type RevocableGrant } from "../lib/ai-consent-state";
import { apiClient } from "./client";

/** Единственная точка чтения согласия на ИИ (GET /me/consents). Purpose, версию и хеш текста задаёт сервер. */
export async function getAiConsent(): Promise<AiConsentState> {
  try {
    return aiConsentState(await apiClient.request<ConsentsResponse>("/me/consents"));
  } catch (error) {
    // Старый сервер без маршрута: согласие этим механизмом не контролируется.
    if (error instanceof ApiRequestError && error.status === 404) return { kind: "not_required" };
    throw error;
  }
}

let deciding = false;
/**
 * Решение по показанной версии текста. Отказ записывается как revoke той же версии (доказательство отказа,
 * отзыв прежнего согласия). Одновременно — только одно решение; устаревшую ревизию (409) не переотправляем.
 */
export async function decideAiConsent(state: Extract<AiConsentState, { kind: "required" }>, decision: "grant" | "revoke") {
  if (decision === "grant") {
    // Разрешение даётся только на показанный текст: уведомление политики должно совпадать с окном, а сама политика —
    // не измениться с момента показа. Иначе запрос не отправляется (окончательную проверку делает сервер).
    if (!noticeMatches(state.policy)) throw new AiConsentChangedError();
    const fresh = await getAiConsent();
    if (fresh.kind !== "required" || !samePolicy(fresh.policy, state.policy) || fresh.revision !== state.revision) throw new AiConsentChangedError();
  }
  return postDecision(consentDecisionBody(state, decision));
}

/** Условия на сервере не совпадают с показанными (нет политики, другой текст/версия или изменились во время чтения). */
export class AiConsentChangedError extends Error {
  constructor() { super("consent_notice_mismatch"); this.name = "AiConsentChangedError"; }
}
const CHANGED_CODES = new Set(["consent_notice_mismatch", "consent_policy_changed", "consent_policy_not_approved_current", "consent_revision_conflict"]);
/** Понятная ошибка для экрана: изменились условия — или решение просто не сохранено. */
export function aiConsentErrorMessage(error: unknown): string {
  if (error instanceof AiConsentChangedError || (error instanceof ApiRequestError && error.code && CHANGED_CODES.has(error.code)))
    return "Условия на сервере изменились или не совпадают с показанным текстом. Разрешение не отправлено, данные в OpenAI не передаются. Ознакомьтесь с актуальными условиями и решите снова.";
  return "Решение не сохранено. Обновите экран и попробуйте ещё раз.";
}

/** Отзыв ранее выданного разрешения в любом режиме сервера, включая off (существующее поведение). */
export function revokeAiConsentGrant(grant: RevocableGrant) {
  return postDecision(revokeGrantBody(grant));
}

async function postDecision(body: object) {
  if (deciding) throw new Error("Решение уже отправляется");
  deciding = true;
  try {
    return await apiClient.request<{ changed: boolean; revision: number }>("/me/consents", { method: "POST", body: JSON.stringify(body) });
  } finally {
    deciding = false;
  }
}
