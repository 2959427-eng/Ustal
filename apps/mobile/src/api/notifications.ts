import { apiClient } from "./client";

export interface AppNotification {
  id: string;
  type: string;
  /** notifyUser() на сервере сам кладёт готовые title/body в payload при создании (apps/api/src/lib/notify.ts). */
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  items: AppNotification[];
  limit: number;
  offset: number;
}

/**
 * GET /notifications (раздел 26 ТЗ) — общий журнал внутри приложения,
 * не зависит от того, дошёл ли push (apps/api/src/lib/notify.ts,
 * src/notifications/push.ts — отдельный, best-effort механизм).
 */
export function getNotifications(params: { limit?: number; offset?: number } = {}): Promise<NotificationsResponse> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.offset != null) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiClient.request<NotificationsResponse>(`/notifications${qs ? `?${qs}` : ""}`);
}

export function markNotificationRead(id: string): Promise<void> {
  return apiClient.request<void>(`/notifications/${id}/read`, { method: "POST", body: "{}" });
}
