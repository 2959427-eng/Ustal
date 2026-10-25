/**
 * Согласие на обработку данных сторонним ИИ (существующий механизм API: GET/POST /me/consents).
 * Чистая логика без сети — тестируется отдельно (ai-consent.test.ts).
 * Маршрут /me/consents зарегистрирован только при USTAL_AI_CONSENT_MODE=enforced: 404 = сервер согласие не требует.
 */
export interface ConsentPolicy { id: string; purpose: string; version: string; content: unknown; policyHash: string; status: string }
export interface ConsentDecisionRow { purpose: string; policyId: string; policyHash: string; decision: "grant" | "revoke"; seq: number; decidedAt: string; effective: boolean }
export interface ConsentsResponse { revision: number; policies: ConsentPolicy[]; decisions: ConsentDecisionRow[]; outboundEnforcement: boolean; aiConsentPurpose?: string | null }

export type AiConsentState =
  | { kind: "not_required" }
  | { kind: "unavailable" } // включено, но утверждённого текста нет — показать нечего, ИИ-обработка не идёт
  | { kind: "required"; policy: ConsentPolicy; text: string; revision: number; status: "granted" | "refused" | "undecided" | "outdated" };

export function policyText(policy: ConsentPolicy): string | null {
  const content = policy.content as { humanText?: unknown } | null;
  return content && typeof content.humanText === "string" && content.humanText.trim() ? content.humanText : null;
}

/** Purpose задаёт сервер из USTAL_AI_CONSENT_PURPOSE. Старый API без этого поля не даёт угадывать согласие. */
export function aiConsentState(res: ConsentsResponse | null): AiConsentState {
  if (!res || !res.outboundEnforcement) return { kind: "not_required" };
  if (!res.aiConsentPurpose) return { kind: "unavailable" };
  const policy = res.policies.find((p) => p.purpose === res.aiConsentPurpose && p.status === "approved");
  const text = policy ? policyText(policy) : null;
  if (!policy || !text) return { kind: "unavailable" };
  const latest = res.decisions.find((d) => d.purpose === policy.purpose);
  const status = !latest ? "undecided"
    : latest.decision === "revoke" ? "refused"
    : latest.policyId === policy.id && latest.policyHash === policy.policyHash && latest.effective ? "granted"
    : "outdated"; // согласие на прежнюю версию текста не действует — нужно новое
  return { kind: "required", policy, text, revision: res.revision, status };
}

/** Нужно ли предложить экран согласия при входе: решения ещё нет или текст обновился. Отказ не переспрашиваем. */
export const shouldPromptAiConsent = (s: AiConsentState) => s.kind === "required" && (s.status === "undecided" || s.status === "outdated");

/** Тело POST /me/consents. Отказ записывается как revoke той же версии — это доказательство отказа и отзыв прежнего согласия. */
export function consentDecisionBody(s: Extract<AiConsentState, { kind: "required" }>, decision: "grant" | "revoke") {
  return { policyId: s.policy.id, policyHash: s.policy.policyHash, decision, expectedRevision: s.revision };
}

export const AI_CONSENT_STATUS_LABEL: Record<"granted" | "refused" | "undecided" | "outdated", string> = {
  granted: "Согласие дано",
  refused: "Согласие не дано",
  undecided: "Решение не принято",
  outdated: "Текст обновлён — нужно новое решение",
};
