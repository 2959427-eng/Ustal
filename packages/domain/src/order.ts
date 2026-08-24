/**
 * Состояния заказа и переходы между ними. Единственное место, которое решает,
 * какой переход допустим — и api, и worker обязаны использовать эту функцию,
 * а не присваивать статус напрямую (см. docs/data-model.md, раздел о constraints).
 */

export type OrderStatus =
  | "draft"
  | "processing"
  | "moderation_hold"
  | "published"
  | "negotiating"
  | "closed"
  | "expired"
  | "cancelled"
  | "rejected";

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["processing"],
  // Фаза 3: автор должен иметь возможность отменить свой заказ, пока он ещё не
  // опубликован — независимо от того, идёт ли по нему AI-обработка или он
  // застрял на ручной модерации (иначе застрявший в moderation_hold заказ
  // нельзя было бы снять с публикации до вмешательства админа).
  processing: ["published", "moderation_hold", "cancelled"],
  moderation_hold: ["published", "rejected", "cancelled"],
  published: ["negotiating", "closed", "expired", "cancelled"],
  negotiating: ["closed", "expired", "cancelled"],
  closed: [],
  expired: [],
  cancelled: [],
  rejected: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new Error(`Invalid order transition: ${from} -> ${to}`);
  }
}

export type ResponseStatus = "active" | "withdrawn" | "not_selected";

export type AssignmentStatus = "selected" | "completed" | "not_completed" | "cancelled";

export type ModerationDecision = "allow" | "allow_with_warning" | "manual_review" | "reject";

export type MatchType = "exact" | "probable" | "new_opportunity";
