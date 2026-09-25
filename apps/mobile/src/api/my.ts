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

/** GET /my/orders (docs/api.md «Лента и мои списки») — заказы, где я автор. */
export function getMyOrders(params: { limit?: number; offset?: number } = {}): Promise<MyOrdersResponse> {
  return apiClient.request<MyOrdersResponse>(`/my/orders${toQuery(params)}`);
}

/** GET /my/responses — заказы, на которые я откликнулся как исполнитель. */
export function getMyResponses(params: { limit?: number; offset?: number } = {}): Promise<MyResponsesResponse> {
  return apiClient.request<MyResponsesResponse>(`/my/responses${toQuery(params)}`);
}
