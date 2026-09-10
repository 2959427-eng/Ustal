import { apiClient } from "./client";

export interface ContactUnlockResult {
  id: string;
  orderId: string;
  executorId: string;
  unlockedAt: string;
}

export interface OrderContact {
  userId: string;
  name: string;
  phone: string;
  whatsappPhone: string | null;
}

/** POST /orders/{id}/contact-unlocks (apps/api/src/routes/contacts.ts) — раскрытие контакта, только автор заказа. */
export function unlockContact(orderId: string, responseId: string): Promise<ContactUnlockResult> {
  return apiClient.request<ContactUnlockResult>(`/orders/${orderId}/contact-unlocks`, {
    method: "POST",
    body: JSON.stringify({ responseId }),
  });
}

/** GET /orders/{id}/contacts/{userId} — телефон/WhatsApp отдаются только сторонам уже раскрытого unlock'а. */
export function getOrderContact(orderId: string, userId: string): Promise<OrderContact> {
  return apiClient.request<OrderContact>(`/orders/${orderId}/contacts/${userId}`);
}
