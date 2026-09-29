import Constants, { ExecutionEnvironment } from "expo-constants";
import { router } from "expo-router";
import { getAccessToken } from "../api/session";
import { consumeOrderRoute, orderIdFromNotification, rememberOrder } from "./navigation";

export async function listenForNotificationTaps(canNavigate: () => boolean = () => true): Promise<() => void> {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return () => {};
  const notifications = await import("expo-notifications");
  const handle = (response: import("expo-notifications").NotificationResponse, navigate: boolean) => {
    const id = orderIdFromNotification(response.notification.request.content.data ?? {});
    if (!id) return;
    rememberOrder(id);
    if (navigate && canNavigate()) void getAccessToken().then((token) => {
      if (token) { const route = consumeOrderRoute(); if (route) router.push(route); }
    }).catch(() => {});
  };
  const last = await notifications.getLastNotificationResponseAsync();
  if (last) { handle(last, false); await notifications.clearLastNotificationResponseAsync(); }
  const subscription = notifications.addNotificationResponseReceivedListener((response) => {
    handle(response, true);
    void notifications.clearLastNotificationResponseAsync().catch(() => {});
  });
  return () => subscription.remove();
}
