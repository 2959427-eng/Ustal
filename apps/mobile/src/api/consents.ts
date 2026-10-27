import { ApiRequestError, ApiSessionChangedError, type ApiSession } from "@ustal/api-client";
import { AI_ACTION_MESSAGES, type AiActionCheck } from "../lib/ai-consent-flow";
import { aiActionGate, aiConsentState, consentDecisionBody, noticeMatches, samePolicy, revokeGrantBody, type AiConsentState, type ConsentsResponse, type RevocableGrant } from "../lib/ai-consent-state";
import { apiClient, currentApiSession } from "./client";

/**
 * Сессия, в которой получено состояние согласия (и его отзываемые разрешения). Решение по состоянию отправляется
 * только от имени этой сессии: обработчик экрана, показанного пользователю A, после входа B не даёт и не отзывает
 * согласие токеном B — даже если экран уже перерисован с состоянием B (2026-10-27).
 */
const stateSession = new WeakMap<object, ApiSession>();
function bindToSession(state: AiConsentState, session: ApiSession): AiConsentState {
  stateSession.set(state, session);
  if (state.kind !== "required") for (const grant of state.revocable ?? []) stateSession.set(grant, session);
  return state;
}
const sessionOf = (value: object): ApiSession => {
  const session = stateSession.get(value);
  if (session === undefined) throw new ApiSessionChangedError(); // состояние не из getAiConsent — решения нет
  return session;
};

/** Единственная точка чтения согласия на ИИ (GET /me/consents). Purpose, версию и хеш текста задаёт сервер. */
export async function getAiConsent(session: ApiSession = currentApiSession()): Promise<AiConsentState> {
  try {
    return bindToSession(aiConsentState(await apiClient.request<ConsentsResponse>("/me/consents", { session })), session);
  } catch (error) {
    // Старый сервер без маршрута: согласие этим механизмом не контролируется.
    if (error instanceof ApiRequestError && error.status === 404) return bindToSession({ kind: "not_required" }, session);
    throw error;
  }
}

/**
 * Проверка перед каждой ИИ-обработкой, запущенной из приложения. Не отправляет ничего, пока решения нет, при отказе,
 * без утверждённых условий и при ошибке проверки. Это удобство интерфейса: блокирует передачу только сервер (enforced).
 */
export async function checkAiAction(session?: ApiSession): Promise<AiActionCheck> {
  let state: AiConsentState;
  try { state = await getAiConsent(session); }
  catch { return { ok: false, gate: "unknown", message: AI_ACTION_MESSAGES.unknown }; }
  const gate = aiActionGate(state);
  if (gate === "allow") return { ok: true };
  if (gate === "ask") return { ok: false, gate, message: AI_ACTION_MESSAGES.ask };
  return { ok: false, gate, message: state.kind === "unavailable" ? AI_ACTION_MESSAGES.unavailable : AI_ACTION_MESSAGES.refused };
}

let deciding = false;
/**
 * Решение по показанной версии текста. Отказ записывается как revoke той же версии (доказательство отказа,
 * отзыв прежнего согласия). Одновременно — только одно решение; устаревшую ревизию (409) не переотправляем.
 */
export async function decideAiConsent(state: Extract<AiConsentState, { kind: "required" }>, decision: "grant" | "revoke") {
  const session = sessionOf(state);
  if (decision === "grant") {
    // Разрешение даётся только на показанный текст: уведомление политики должно совпадать с окном, а сама политика —
    // не измениться с момента показа. Иначе запрос не отправляется (окончательную проверку делает сервер).
    if (!noticeMatches(state.policy)) throw new AiConsentChangedError();
    const fresh = await getAiConsent(session);
    if (fresh.kind !== "required" || !samePolicy(fresh.policy, state.policy) || fresh.revision !== state.revision) throw new AiConsentChangedError();
  }
  return postDecision(consentDecisionBody(state, decision), session);
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
export async function revokeAiConsentGrant(grant: RevocableGrant) {
  return postDecision(revokeGrantBody(grant), sessionOf(grant));
}

async function postDecision(body: object, session: ApiSession) {
  if (deciding) throw new Error("Решение уже отправляется");
  deciding = true;
  try {
    return await apiClient.request<{ changed: boolean; revision: number }>("/me/consents", { method: "POST", body: JSON.stringify(body), session });
  } finally {
    deciding = false;
  }
}
