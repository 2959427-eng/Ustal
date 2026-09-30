import { useCallback, useEffect } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getNotifications, markNotificationRead } from "../api/notifications";
import { countNotificationBadges, unreadNotificationIdsForOrder } from "../lib/notification-badges";

/**
 * Тот же ключ и запрос, что у экрана «Уведомления» (app/notifications.tsx): прочтение там сразу
 * обновляет бейджи. Учитываются последние 50 уведомлений (максимум страницы GET /notifications).
 */
const notificationsQuery = { queryKey: ["notifications"], queryFn: () => getNotifications({ limit: 50 }) };

export function useNotificationBadges(): { orders: number; opportunities: number } {
  const { data, refetch } = useQuery({ ...notificationsQuery, refetchInterval: 30_000 });
  useFocusEffect(useCallback(() => { void refetch(); }, [refetch]));
  return countNotificationBadges(data?.items ?? []);
}

/** Открытие заказа = прочтение его уведомлений (для заказчика и для исполнителя). */
export function useMarkOrderNotificationsRead(orderId: string | undefined): void {
  const queryClient = useQueryClient();
  const { data } = useQuery(notificationsQuery);
  const ids = orderId && data ? unreadNotificationIdsForOrder(data.items, orderId) : [];
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    void Promise.allSettled(key.split(",").map((id) => markNotificationRead(id))).then(() =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }));
  }, [key, queryClient]);
}
