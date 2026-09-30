/**
 * Бейджи «Заказы» / «Возможности» на главной (2026-09-30): только непрочитанные уведомления,
 * а не число заказов. Типы уведомлений создаёт сервер (notifyUser в apps/api/src/routes/*):
 *  - «Заказы» — события по МОИМ заказам (я заказчик);
 *  - «Возможности» — события по заказам, где я откликнулся (я исполнитель).
 * Неизвестные типы в бейджи не попадают (видны в общем журнале уведомлений).
 */
export const ORDER_NOTIFICATION_TYPES: readonly string[] = [
  "new_response",
  "executor_reported_completed",
  "executor_reported_issue",
];
export const OPPORTUNITY_NOTIFICATION_TYPES: readonly string[] = [
  "selected",
  "not_selected",
  "assignment_started",
  "selection_cancelled",
  "assignment_completed",
  "assignment_not_completed",
  "contact_unlocked",
];

export interface BadgeNotification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
}

export function countNotificationBadges(items: readonly BadgeNotification[]): { orders: number; opportunities: number } {
  let orders = 0;
  let opportunities = 0;
  for (const n of items) {
    if (n.readAt) continue;
    if (ORDER_NOTIFICATION_TYPES.includes(n.type)) orders++;
    else if (OPPORTUNITY_NOTIFICATION_TYPES.includes(n.type)) opportunities++;
  }
  return { orders, opportunities };
}

/** Непрочитанные уведомления этого заказа: открытие заказа считается их прочтением. */
export function unreadNotificationIdsForOrder(items: readonly BadgeNotification[], orderId: string): string[] {
  return items.filter((n) => !n.readAt && n.payload.orderId === orderId).map((n) => n.id);
}
