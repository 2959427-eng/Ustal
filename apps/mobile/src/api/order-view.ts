import { apiClient } from "./client";
import type { OrderStatus } from "./orders";

export interface OrderView {
  id: string;
  status: OrderStatus;
  title: string | null;
  description: string | null;
  cityId: string;
  cityName: string | null;
  priceMinor: number | null;
  currency: string;
  acceptsPriceOffers: boolean;
  photoMediaIds: string[];
  canRespond: boolean;
  /** false — заказчик остановил приём откликов или набран лимит (2026-10-15). Необязательно — старый API. */
  acceptingResponses?: boolean;
}
export function getOrderView(orderId: string): Promise<OrderView> {
  return apiClient.request(`/orders/${encodeURIComponent(orderId)}/view`);
}
