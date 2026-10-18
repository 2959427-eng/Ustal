import type { AssignmentStatus, OrderStatus } from "../api/orders";
/** Cancelled negotiations do not imply cancellation of the whole multi-candidate order. */
export function responseStatusLabel(status: "active" | "withdrawn" | "not_selected", orderStatus: OrderStatus | string | null, assignmentStatus: AssignmentStatus | null = null): string {
  if (orderStatus === "cancelled") return "Заказ отменён";
  if (status === "withdrawn") return "Отозван";
  if (status === "not_selected") return assignmentStatus === "cancelled" ? "Переговоры отменены" : "Не выбран";
  return "Ожидает решения";
}
