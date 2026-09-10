import { apiClient } from "./client";
import type { AssignmentStatus, ResponseStatus } from "./orders";

export interface CreateResponseInput {
  offeredPriceMinor?: number;
  comment?: string;
  availabilityText?: string;
}

export interface ResponseCreated {
  id: string;
  orderId: string;
  status: ResponseStatus;
  offeredPriceMinor: number | null;
  comment: string | null;
  availabilityText: string | null;
  createdAt: string;
}

export interface OrderCandidate {
  id: string;
  executorId: string;
  executorName: string | null;
  status: ResponseStatus;
  offeredPriceMinor: number | null;
  comment: string | null;
  availabilityText: string | null;
  createdAt: string;
  isContactUnlocked: boolean;
  assignmentId: string | null;
  assignmentStatus: AssignmentStatus | null;
}

export interface OrderCandidatesResponse {
  items: OrderCandidate[];
}

/**
 * POST /orders/{id}/responses (apps/api/src/routes/responses.ts) — отклик
 * исполнителя. Idempotency-Key не нужен: сервер сам ловит дубль уникальным
 * индексом (409 already_responded).
 */
export function createResponse(orderId: string, input: CreateResponseInput): Promise<ResponseCreated> {
  return apiClient.request<ResponseCreated>(`/orders/${orderId}/responses`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Автор заказа: список откликнувшихся кандидатов (404 для не-автора). */
export function getOrderCandidates(orderId: string): Promise<OrderCandidatesResponse> {
  return apiClient.request<OrderCandidatesResponse>(`/orders/${orderId}/responses`);
}

export function withdrawResponse(responseId: string): Promise<void> {
  return apiClient.request<void>(`/responses/${responseId}`, { method: "DELETE" });
}
