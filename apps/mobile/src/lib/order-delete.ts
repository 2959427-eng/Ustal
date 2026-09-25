import type { OrderStatus } from "../api/orders";

/**
 * Заказ можно удалить, пока по нему нет договорённости: как только начались переговоры хотя бы
 * с одним кандидатом (negotiating), и в завершённых состояниях (closed, expired, rejected,
 * cancelled) — нельзя. Итоговое решение всегда за сервером (POST /orders/{id}/cancel), это
 * только скрывает лишние кнопки.
 */
const DELETABLE: readonly OrderStatus[] = ["processing", "processing_failed", "moderation_hold", "published"];

export function canDeleteOrder(status: OrderStatus): boolean {
  return DELETABLE.includes(status);
}
