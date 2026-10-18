import { ApiRequestError } from "@ustal/api-client";
import { normalizeProfileItemIdentity } from "@ustal/domain/profile-item-identity";
import {
  RESTRICTION_LABELS, resourceLabel,
  type ProfileItemAction, type ProfileItemKind, type ProfileResponse, type RestrictionType,
} from "../api/profile";

/**
 * Прямое управление сохранёнными пунктами профиля без AI (2026-10-17, Phase C):
 * «Убрать» (навык/ресурс), «Снять ограничение», «Восстановить» убранное. Только server action
 * (POST /profile/items/:kind/:id/:action) и затем полный перечитанный GET /profile: версия и id пунктов
 * меняются после каждого действия, поэтому старые id не используются, состояние локально не подменяется.
 * Никаких сообщений AI, никаких удалений исходных сообщений, без проверки лимита AI-сообщений.
 */
export interface ItemRow { key: string; kind: ProfileItemKind; id: string; label: string; group?: string }

/** Действующие пункты с id текущей версии (порядок и подписи — как в показе профиля, одна строка на пункт). */
export function profileItemRows(p: ProfileResponse | undefined): { capabilities: ItemRow[]; resources: ItemRow[]; restrictions: ItemRow[]; removed: ItemRow[] } {
  const seen = new Set<string>();
  const unique = (kind: ProfileItemKind, label: string) => {
    const k = `${kind}:${normalizeProfileItemIdentity(label)}`;
    if (!normalizeProfileItemIdentity(label) || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const row = (kind: ProfileItemKind, id: string, label: string, group?: string): ItemRow => ({ key: `${kind}:${id}`, kind, id, label, ...(group ? { group } : {}) });
  const capabilities: ItemRow[] = [], resources: ItemRow[] = [];
  for (const c of p?.capabilities ?? []) if (unique("capability", c.label)) capabilities.push(row("capability", c.id, c.label));
  for (const r of p?.resources ?? []) {
    const label = resourceLabel(r.label, r.itemAttributes);
    if (unique("resource", label)) resources.push(row("resource", r.id, label));
  }
  for (const f of p?.unmapped ?? []) {
    if (!f.id) continue; // старый API без id — действие невозможно, пункт показывается в обычной сводке
    const label = f.kind === "resource" ? resourceLabel(f.phrase, f.itemAttributes) : f.phrase;
    if (unique(f.kind, label)) (f.kind === "resource" ? resources : capabilities).push(row(f.kind, f.id, label));
  }
  const order: RestrictionType[] = ["time", "work", "scope"];
  const restrictions = [...(p?.restrictions ?? [])]
    .filter((r) => !!r.id && !!r.text.trim())
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    .filter((r) => unique("restriction", `${r.type}:${r.text}`))
    .map((r) => row("restriction", r.id!, r.text.trim(), RESTRICTION_LABELS[r.type]));
  const removed = (p?.removed ?? []).filter((r) => !!r.id && !!r.label.trim()).map((r) => row(r.kind, r.id, r.label.trim()));
  return { capabilities, resources, restrictions, removed };
}

export const ITEM_ACTION_LABEL: Record<ProfileItemKind, Record<ProfileItemAction, string>> = {
  capability: { revoke: "Убрать", restore: "Восстановить" },
  resource: { revoke: "Убрать", restore: "Восстановить" },
  restriction: { revoke: "Снять ограничение", restore: "Восстановить" },
};
export const REMOVED_KIND_LABEL: Record<ProfileItemKind, string> = { capability: "навык", resource: "ресурс", restriction: "ограничение" };

/** Понятный текст ошибки и нужно ли перечитать профиль (id устарели / пункт уже изменился). */
export function itemActionError(err: unknown): { message: string; refresh: boolean } {
  if (err instanceof ApiRequestError) {
    if (err.status === 409 && err.code === "profile_draft_pending")
      return { message: "Сначала примените или отклоните ожидающие изменения профиля.", refresh: false };
    if (err.status === 409 && err.code === "profile_rebuilding")
      return { message: "Профиль сейчас обновляется. Попробуйте ещё раз через несколько секунд.", refresh: false };
    if (err.status === 409 && err.code === "stale_item")
      return { message: "Профиль изменился — список обновлён. Нажмите ещё раз, если действие всё ещё нужно.", refresh: true };
    if (err.status === 409) return { message: "Профиль изменился — список обновлён.", refresh: true };
    if (err.status === 429) return { message: "Слишком много изменений профиля. Попробуйте позже.", refresh: false };
    if (err.status === 404) return { message: "Этот пункт уже изменился — список обновлён.", refresh: true };
  }
  return { message: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.", refresh: false };
}

export interface ItemActionState { pendingKey: string | null; error: string | null; errorKey: string | null }
export interface ItemActionDeps {
  call: (kind: ProfileItemKind, id: string, action: ProfileItemAction) => Promise<unknown>;
  /** Перечитать GET /profile (и положить в кэш). */
  refresh: () => Promise<unknown>;
  onState: (s: ItemActionState) => void;
}

/**
 * Одно действие за раз (id всех пунктов меняются после любого действия): повторное нажатие, пока действие
 * выполняется, игнорируется — ни второго запроса, ни повтора с устаревшим id. Ошибка — пункт остаётся как был
 * (состояние не подменялось), показывается текст; при stale/404 профиль перечитывается, действие НЕ повторяется.
 */
export function createItemActions(deps: ItemActionDeps) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(row: Pick<ItemRow, "key" | "kind" | "id">, action: ProfileItemAction): Promise<"done" | "failed" | "ignored"> {
      if (busy) return "ignored";
      busy = true;
      deps.onState({ pendingKey: row.key, error: null, errorKey: null });
      try {
        await deps.call(row.kind, row.id, action);
        const refreshed = await deps.refresh().then(() => true, () => false);
        deps.onState(refreshed ? { pendingKey: null, error: null, errorKey: null }
          : { pendingKey: null, error: "Изменение сохранено, но список не обновился. Обновите экран.", errorKey: null });
        return "done";
      } catch (err) {
        const { message, refresh } = itemActionError(err);
        if (refresh) await deps.refresh().catch(() => undefined);
        deps.onState({ pendingKey: null, error: message, errorKey: row.key });
        return "failed";
      } finally {
        busy = false;
      }
    },
  };
}
