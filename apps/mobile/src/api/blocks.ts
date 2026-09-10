import { apiClient } from "./client";

export interface BlockedUser {
  id: string;
  blockedId: string;
  blockedName: string | null;
  createdAt: string;
}

export interface BlocksResponse {
  items: BlockedUser[];
}

export interface BlockCreated {
  id: string;
  blockedId: string;
  createdAt: string;
}

/** GET /blocks (раздел 29 ТЗ) — заблокированные этим пользователем. */
export function getBlocks(): Promise<BlocksResponse> {
  return apiClient.request<BlocksResponse>("/blocks");
}

/**
 * POST /blocks (раздел 28/29 ТЗ) — блокировка конкретного человека. Это
 * контекстное действие (из карточки заказа/кандидата/отклика), не отдельный
 * экран — см. app/order/[id].tsx.
 */
export function blockUser(blockedId: string): Promise<BlockCreated> {
  return apiClient.request<BlockCreated>("/blocks", {
    method: "POST",
    body: JSON.stringify({ blockedId }),
  });
}

export function unblockUser(id: string): Promise<void> {
  return apiClient.request<void>(`/blocks/${id}`, { method: "DELETE" });
}
