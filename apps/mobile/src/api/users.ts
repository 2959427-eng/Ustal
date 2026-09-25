import { apiClient } from "./client";
import type { Reputation } from "./reviews";

export interface PublicProfile {
  id: string;
  name: string;
  avatarMediaId: string | null;
  about: string | null;
  cityId: string;
  memberSince: string;
  reputation: Reputation;
}

/** GET /orders/{id}/author — заказчик заказа (аватарка на экране заказа). */
export function getOrderAuthor(orderId: string): Promise<PublicProfile> {
  return apiClient.request<PublicProfile>(`/orders/${orderId}/author`);
}

/** GET /users/{id}?orderId= — публичный профиль заказчика в контексте заказа. */
export function getPublicProfile(userId: string, orderId: string): Promise<PublicProfile> {
  return apiClient.request<PublicProfile>(`/users/${userId}?orderId=${encodeURIComponent(orderId)}`);
}
