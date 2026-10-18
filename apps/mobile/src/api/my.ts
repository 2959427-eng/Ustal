import { apiClient } from "./client";
import { toQuery } from "../lib/query-string";
import type { AssignmentStatus, ModerationStatus, OrderStatus } from "./orders";

export interface MyOrderItem {
  id: string;
  photoMediaIds?: string[];
  /** Активные отклики (отозванные не считаются). */
  activeResponsesCount?: number;
  status: OrderStatus;
  moderationStatus: ModerationStatus;
  normalizedTitle: string | null;
  priceMinor: number | null;
  currency: string;
  createdAt: string;
  publishedAt: string | null;
  closedAt: string | null;
  /** «Оценить»: заказ выполнен, моя оценка не поставлена и не пропущена. */
  ratingPending: boolean;
  /** Заказ в моём архиве. */
  archived: boolean;
}

export interface MyOrdersResponse {
  items: MyOrderItem[];
  limit: number;
  offset: number;
}

export interface MyResponseItem {
  id: string;
  orderId: string;
  orderTitle: string | null;
  orderStatus: OrderStatus | null;
  orderAuthorId: string | null;
  status: "active" | "withdrawn" | "not_selected";
  offeredPriceMinor: number | null;
  comment: string | null;
  availabilityText: string | null;
  createdAt: string;
  isContactUnlocked: boolean;
  assignmentStatus: AssignmentStatus | null;
  /** Нужен, чтобы отметить "работа выполнена"/"не получилось" (POST .../executor-report-*). */
  assignmentId: string | null;
  /** Моя собственная отметка о результате — сигнал заказчику, не финальный статус. */
  executorReport: "completed" | "issue" | null;
  executorReportAt: string | null;
  // Упрощение рейтинга (2026-09-22): исполнитель заказчика больше не
  // оценивает, поэтому ratingPending здесь больше нет (было раньше).
  archived: boolean;
}

export interface MyResponsesResponse {
  items: MyResponseItem[];
  limit: number;
  offset: number;
}

export interface ListParams { limit?: number; offset?: number }
export const myKeys = {
  orders: (params: ListParams = {}) => ["my-orders", "all", { limit: Math.min(50, params.limit ?? 50), offset: params.offset ?? 0 }] as const,
  responses: (params: ListParams = {}) => ["my-responses", "all", { limit: Math.min(50, params.limit ?? 50), offset: params.offset ?? 0 }] as const,
  response: (orderId: string) => ["my-responses", "order", orderId] as const,
};

// Existing screens consume complete lists. limit is a batch size, not a truncation
// boundary; the untouched Opportunities screen also benefits without UI changes.
async function allPages<T extends { id: string }>(path: string, params: ListParams): Promise<{ items: T[]; limit: number; offset: number }> {
  const limit = Math.max(1, Math.min(50, params.limit ?? 50));
  const start = Math.max(0, params.offset ?? 0);
  let offset = start;
  const items = new Map<string, T>();
  for (;;) {
    const page = await apiClient.request<{ items: T[]; limit: number; offset: number }>(`${path}${toQuery({ limit, offset })}`);
    for (const item of page.items) items.set(item.id, item);
    if (page.items.length < page.limit) break;
    if (page.limit < 1 || page.offset !== offset) throw new Error("Invalid pagination response");
    offset += page.limit;
  }
  return { items: [...items.values()], limit, offset: start };
}

export function getMyOrders(params: ListParams = {}): Promise<MyOrdersResponse> { return allPages<MyOrderItem>("/my/orders", params); }
export function getMyResponses(params: ListParams = {}): Promise<MyResponsesResponse> { return allPages<MyResponseItem>("/my/responses", params); }
export async function getMyResponse(orderId: string): Promise<MyResponseItem | null> {
  const page = await apiClient.request<MyResponsesResponse>(`/my/responses${toQuery({ orderId, limit: 1 })}`);
  return page.items[0] ?? null;
}
