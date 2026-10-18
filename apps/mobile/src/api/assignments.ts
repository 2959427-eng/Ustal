import { apiClient } from "./client";
import type { AssignmentStatus, OrderStatus } from "./orders";

export interface AssignmentCreated {
  id: string;
  orderId: string;
  executorId: string;
  status: AssignmentStatus;
  selectedAt: string;
}

export interface CloseOrderResult {
  id: string;
  status: OrderStatus;
  notSelectedCount: number;
}

export interface AssignmentResult {
  id: string;
  status: AssignmentStatus;
}

/** POST /orders/{id}/assignments (apps/api/src/routes/assignments.ts) — начать переговоры с кандидатом (статус assignment становится "selected"); не финальный выбор исполнителя — требует уже раскрытого контакта. */
export function selectCandidate(orderId: string, responseId: string): Promise<AssignmentCreated> {
  return apiClient.request<AssignmentCreated>(`/orders/${orderId}/assignments`, {
    method: "POST",
    body: JSON.stringify({ responseId }),
  });
}

/** Единственное действие, блокирующее новые отклики; ещё активные отклики переводятся в not_selected. */
export function closeOrder(orderId: string): Promise<CloseOrderResult> {
  return apiClient.request<CloseOrderResult>(`/orders/${orderId}/close`, { method: "POST", body: "{}" });
}

/** «Договорились» / «Начать выполнение»: selected → in_progress («В работе»). */
export function startAssignment(orderId: string, assignmentId: string): Promise<AssignmentResult> {
  return apiClient.request<AssignmentResult>(`/orders/${orderId}/assignments/${assignmentId}/start`, {
    method: "POST",
    body: "{}",
  });
}

/** Отмена выбора (пока не «Договорились»): контакт закрывается, заказ снова «Опубликован». */
export function cancelSelection(orderId: string, assignmentId: string): Promise<AssignmentResult> {
  return apiClient.request<AssignmentResult>(`/orders/${orderId}/assignments/${assignmentId}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

export function completeAssignment(orderId: string, assignmentId: string): Promise<AssignmentResult> {
  return apiClient.request<AssignmentResult>(`/orders/${orderId}/assignments/${assignmentId}/complete`, {
    method: "POST",
    body: "{}",
  });
}

export function markAssignmentNotCompleted(orderId: string, assignmentId: string, reason?: string): Promise<AssignmentResult> {
  return apiClient.request<AssignmentResult>(`/orders/${orderId}/assignments/${assignmentId}/not-completed`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export interface ExecutorReportResult {
  id: string;
  executorReport: "completed" | "issue" | null;
  executorReportAt: string | null;
}

/**
 * Исполнитель отмечает "работа выполнена" в статусе in_progress — это
 * только сигнал заказчику (см. apps/api/src/routes/assignments.ts), заказ
 * сам НЕ завершает: окончательно закрывает работу только заказчик через
 * completeAssignment/markAssignmentNotCompleted выше.
 */
export function reportAssignmentCompleted(orderId: string, assignmentId: string): Promise<ExecutorReportResult> {
  return apiClient.request<ExecutorReportResult>(`/orders/${orderId}/assignments/${assignmentId}/executor-report-completed`, {
    method: "POST",
    body: "{}",
  });
}

/** Исполнитель сообщает, что не получилось выполнить — тоже только сигнал, не финализирует заказ. */
export function reportAssignmentIssue(orderId: string, assignmentId: string): Promise<ExecutorReportResult> {
  return apiClient.request<ExecutorReportResult>(`/orders/${orderId}/assignments/${assignmentId}/executor-report-issue`, {
    method: "POST",
    body: "{}",
  });
}
