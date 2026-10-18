import { apiClient } from "./client";

/**
 * Обе стороны оценивают друг друга после завершённого заказа: заказчик
 * исполнителя и исполнитель заказчика, независимо. pending — «мне есть
 * кого оценить по этому заказу»; targetRole (только при pending: true)
 * говорит RatingCard, кого именно — "executor" или "customer".
 */
export interface RatingState {
  pending: boolean;
  targetRole?: "executor" | "customer";
}

export interface Reputation {
  executor: { rating: number | null; ratingCount: number; completed: number; notCompleted: number };
  customer: { rating: number | null; ratingCount: number; total: number; completed: number; cancelled: number };
}

/** GET /orders/{id}/rating (apps/api/src/routes/reviews.ts). 404 — не участник / нет выполненной работы. */
export function getOrderRating(orderId: string): Promise<RatingState> {
  return apiClient.request<RatingState>(`/orders/${orderId}/rating`);
}

/** POST /orders/{id}/rating — оценка 1–5 или пропуск (rating: null). Текстовых отзывов нет. */
export function rateOrder(orderId: string, rating: number | null): Promise<{ orderId: string; skipped: boolean }> {
  return apiClient.request(`/orders/${orderId}/rating`, { method: "POST", body: JSON.stringify({ rating }) });
}

/** GET /me/reputation — своя репутация для «Моего профиля». */
export function getMyReputation(): Promise<Reputation> {
  return apiClient.request<Reputation>("/me/reputation");
}
