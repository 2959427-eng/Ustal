/**
 * Согласие на обработку данных сторонним ИИ (существующий механизм API: GET/POST /me/consents).
 * Чистая логика без сети — тестируется отдельно (ai-consent.test.ts).
 * Маршрут /me/consents зарегистрирован только при USTAL_AI_CONSENT_MODE=enforced: 404 = сервер согласие не требует.
 */
import { AI_CONSENT_TEXT } from "./ai-consent-flow";

export interface ConsentPolicy { id: string; purpose: string; version: string; content: unknown; policyHash: string; status: string }
export interface ConsentDecisionRow { purpose: string; policyId: string; policyHash: string; decision: "grant" | "revoke"; seq: number; decidedAt: string; effective: boolean }
export interface ConsentsResponse { revision: number; policies: ConsentPolicy[]; decisions: ConsentDecisionRow[]; outboundEnforcement: boolean; aiConsentPurpose?: string | null }

/** Ранее выданное разрешение, которое можно отозвать в любом режиме (в т.ч. off): отзыв записывается сервером. */
export interface RevocableGrant { purpose: string; policyId: string; policyHash: string; revision: number }

export type AiConsentState =
  | { kind: "not_required"; revocable?: RevocableGrant[] }
  // включено, но утверждённых условий нет или их уведомление не совпадает с текстом окна — grant невозможен, ИИ не идёт
  | { kind: "unavailable"; reason?: "notice_mismatch"; revocable?: RevocableGrant[] }
  | { kind: "required"; policy: ConsentPolicy; text: string; revision: number; status: "granted" | "refused" | "undecided" | "outdated" };

/** Черновик или незаполненный шаблон никогда не показывается как условия, на которые можно согласиться. */
const UNFINISHED_TEXT = /TBD|TODO|PLACEHOLDER|DRAFT|ЧЕРНОВИК|ПРОЕКТ|\[USTAL_|\[УКАЗАТЬ|\[ПРОВЕРИТЬ/i;

export function policyText(policy: ConsentPolicy): string | null {
  const content = policy.content as { humanText?: unknown } | null;
  const text = content && typeof content.humanText === "string" ? content.humanText.trim() : "";
  return text && !UNFINISHED_TEXT.test(text) ? text : null;
}

/** Уведомление политики (content.notice) должно дословно совпадать с утверждённым текстом окна AI_CONSENT_TEXT. */
export function noticeMatches(policy: ConsentPolicy): boolean {
  const notice = (policy.content as { notice?: unknown } | null)?.notice;
  return Array.isArray(notice) && notice.length === AI_CONSENT_TEXT.length && AI_CONSENT_TEXT.every((p, i) => notice[i] === p);
}

/** Purpose задаёт сервер из USTAL_AI_CONSENT_PURPOSE. Старый API без этого поля не даёт угадывать согласие. */
/** Последнее решение по каждому purpose — grant (действующий или по устаревшей версии). Существующее поведение экрана до 2026-10-26. */
export function revocableGrants(res: ConsentsResponse): RevocableGrant[] {
  const latest = new Map<string, ConsentDecisionRow>();
  for (const d of res.decisions) if (!latest.has(d.purpose)) latest.set(d.purpose, d);
  return [...latest.values()].filter((d) => d.decision === "grant")
    .map((d) => ({ purpose: d.purpose, policyId: d.policyId, policyHash: d.policyHash, revision: res.revision }));
}
const withRevocable = <K extends "not_required" | "unavailable">(kind: K, res: ConsentsResponse) => {
  const revocable = revocableGrants(res);
  return (revocable.length ? { kind, revocable } : { kind }) as Extract<AiConsentState, { kind: K }>;
};

export function aiConsentState(res: ConsentsResponse | null): AiConsentState {
  if (!res) return { kind: "not_required" };
  if (!res.outboundEnforcement) return withRevocable("not_required", res);
  if (!res.aiConsentPurpose) return withRevocable("unavailable", res);
  const policy = res.policies.find((p) => p.purpose === res.aiConsentPurpose && p.status === "approved");
  const text = policy ? policyText(policy) : null;
  if (!policy || !text) return withRevocable("unavailable", res);
  if (!noticeMatches(policy)) return { ...withRevocable("unavailable", res), reason: "notice_mismatch" };
  const latest = res.decisions.find((d) => d.purpose === policy.purpose);
  const status = !latest ? "undecided"
    : latest.decision === "revoke" ? "refused"
    : latest.policyId === policy.id && latest.policyHash === policy.policyHash && latest.effective ? "granted"
    : "outdated"; // согласие на прежнюю версию текста не действует — нужно новое
  return { kind: "required", policy, text, revision: res.revision, status };
}

/**
 * Перед любой ИИ-обработкой (профиль, заказ, повтор разбора): allow — отправлять; ask — сначала окно согласия;
 * blocked — не отправлять (отказ или нет утверждённых условий). not_required (режим off) — allow: сервер разрешения
 * не запрашивает и сам ничего не блокирует; эта проверка в интерфейсе защитой не является.
 */
export type AiActionGate = "allow" | "ask" | "blocked";
export function aiActionGate(s: AiConsentState): AiActionGate {
  if (s.kind === "not_required") return "allow";
  if (s.kind === "unavailable") return "blocked";
  if (s.status === "granted") return "allow";
  return s.status === "refused" ? "blocked" : "ask";
}

/** Нужно ли предложить экран согласия при входе: решения ещё нет или текст обновился. Отказ не переспрашиваем. */
export const shouldPromptAiConsent = (s: AiConsentState) => s.kind === "required" && (s.status === "undecided" || s.status === "outdated");

/** Тело POST /me/consents. Отказ записывается как revoke той же версии — это доказательство отказа и отзыв прежнего согласия. */
/** Отзыв ранее выданного разрешения по его собственной версии (сервер принимает revoke и в режиме off). */
export const revokeGrantBody = (g: RevocableGrant) =>
  ({ policyId: g.policyId, policyHash: g.policyHash, decision: "revoke" as const, expectedRevision: g.revision });

/** Grant несёт версию и дословный показанный текст — сервер сверяет их с текущей утверждённой политикой под блокировкой. */
export function consentDecisionBody(s: Extract<AiConsentState, { kind: "required" }>, decision: "grant" | "revoke") {
  const base = { policyId: s.policy.id, policyHash: s.policy.policyHash, policyVersion: s.policy.version, decision, expectedRevision: s.revision };
  return decision === "grant" ? { ...base, notice: [...AI_CONSENT_TEXT] } : base;
}

/** Та же ли политика (id, хеш, версия) — проверка перед отправкой grant. */
export const samePolicy = (a: ConsentPolicy, b: ConsentPolicy) => a.id === b.id && a.policyHash === b.policyHash && a.version === b.version;

export const AI_CONSENT_STATUS_LABEL: Record<"granted" | "refused" | "undecided" | "outdated", string> = {
  granted: "Согласие дано",
  refused: "Согласие не дано",
  undecided: "Решение не принято",
  outdated: "Текст обновлён — нужно новое решение",
};
