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

/** POST /orders/{id}/assignments (apps/api/src/routes/assignments.ts) — выбор исполнителя; требует уже раскрытого контакта. */
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
