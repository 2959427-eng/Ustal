import { apiClient } from "./client";

export interface CreateReviewInput {
  toUserId: string;
  orderId: string;
  rating: number;
  text?: string;
}

export interface Review {
  id: string;
  fromUserId: string;
  toUserId: string;
  lastOrderId: string;
  rating: number;
  text: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /reviews (apps/api/src/routes/reviews.ts) — отзыв привязан к паре
 * пользователей, не к заказу (повторная совместная работа обновляет
 * существующую запись); право оставить отзыв проверяет сервер (нужен
 * completed order_assignment между этой парой по указанному заказу).
 */
export function submitReview(input: CreateReviewInput): Promise<Review> {
  return apiClient.request<Review>("/reviews", { method: "POST", body: JSON.stringify(input) });
}
