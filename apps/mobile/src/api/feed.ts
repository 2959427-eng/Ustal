import { apiClient } from "./client";
import { toQuery } from "../lib/query-string";
import type { ModerationStatus, OrderStatus } from "./orders";

export interface FeedItem {
  orderId: string;
  title: string | null;
  description: string | null;
  cityId: string;
  priceMinor: number | null;
  currency: string;
  createdAt: string;
  score: number;
  matchType: "exact" | "probable" | "new_opportunity";
  explanation: string;
}

export interface FeedResponse {
  items: FeedItem[];
  limit: number;
  offset: number;
}

/**
 * GET /feed (docs/matching.md §13.5) — лента подобранных AI заказов, читает
 * уже посчитанные matching_candidates, а не пересчитывает на лету. Без
 * агрегированного числа исполнителей (architecture.md §5 п.6).
 */
export function getFeed(params: { limit?: number; offset?: number } = {}): Promise<FeedResponse> {
  return apiClient.request<FeedResponse>(`/feed${toQuery(params)}`);
}

// Реэкспорт для удобства импорта в экранах ленты/моих заказов из одного места.
export type { OrderStatus, ModerationStatus };
