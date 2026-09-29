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
}
export function getOrderView(orderId: string): Promise<OrderView> {
  return apiClient.request(`/orders/${encodeURIComponent(orderId)}/view`);
}
