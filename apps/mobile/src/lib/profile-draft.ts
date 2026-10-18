import type { ProfileDraftDiff } from "../api/profile";

/**
 * Статус AI-разбора текста «Навыки и ресурсы» (2026-09-30). После «Сохранить» пользователь сразу
 * возвращается в «Мой профиль», а тот показывает, что AI ещё думает / что-то нашёл / ничего не нашёл.
 * Отметку «текст отправлен» хранит кэш react-query под этим ключом: время отправки и id черновика,
 * который уже был на сервере до отправки (он НЕ ответ на новый текст — иначе старый пустой черновик
 * от прошлой попытки показывался бы как «AI не нашёл»).
 */
export const PROFILE_INPUT_PENDING_KEY = ["profileInputPending"] as const;
export interface ProfileInputPending {
  at: number;
  prevDraftId: string | null;
}

/** Черновик — ответ AI на отправленный текст, только если его не было до отправки. */
export function isResponseDraft(draftId: string | null, pending: ProfileInputPending | null): boolean {
  if (!draftId) return false;
  return pending === null || draftId !== pending.prevDraftId;
}
export const PROFILE_AI_WAIT_MS = 45_000;
/** После этого срока без черновика считаем, что разбор не дошёл (worker/AI недоступны), а не «ничего не нашёл». */
export const PROFILE_AI_GIVE_UP_MS = 180_000;

export function isDraftEmpty(diff: ProfileDraftDiff): boolean {
  return (
    diff.addedCapabilities.length === 0 &&
    diff.addedResources.length === 0 &&
    (diff.addedUnmapped ?? []).length === 0 &&
    diff.removedCapabilities.length === 0 &&
    diff.removedResources.length === 0
  );
}

export type ProfileAiStatus = "idle" | "processing" | "slow" | "no_response" | "review" | "nothing_found";

/** hasDraft/draftEmpty — текущий черновик на сервере; pendingAt — когда отправлен текст (или null). */
export function profileAiStatus(input: { hasDraft: boolean; draftEmpty: boolean; pendingAt: number | null; now: number }): ProfileAiStatus {
  if (input.hasDraft) return input.draftEmpty ? "nothing_found" : "review";
  if (input.pendingAt === null) return "idle";
  const elapsed = input.now - input.pendingAt;
  // Нет черновика — значит AI ещё не ответил. «Ничего не нашёл» говорим только по пустому черновику.
  if (elapsed < PROFILE_AI_WAIT_MS) return "processing";
  return elapsed < PROFILE_AI_GIVE_UP_MS ? "slow" : "no_response";
}
