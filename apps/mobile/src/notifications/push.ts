import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { apiClient } from "../api/client";
import { withDeadline } from "../lib/deadline";

const TOKEN_KEY = "ustal.pushToken";
let registration: Promise<void> | null = null;
let generation = 0;
let lastRegisteredToken: string | null = null;

export function ensurePushRegistered(): Promise<void> {
  if (registration) return registration;
  const current = generation;
  const task = register(current).catch(() => {
    // No token or provider payload in production logs. In-app notifications still work.
  }).finally(() => { if (registration === task) registration = null; });
  registration = task;
  return task;
}

async function register(current: number): Promise<void> {
  if (!["ios", "android"].includes(Platform.OS) || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return; // Never ask Expo to infer the project from an unrelated client.
  const Notifications = await import("expo-notifications");
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
  if (Platform.OS === "android" && Notifications.setNotificationChannelAsync) {
    await Notifications.setNotificationChannelAsync("default", { name: "USTAL", importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted" || current !== generation) return;
  const { data: token } = await withDeadline(Notifications.getExpoPushTokenAsync({ projectId }), 15_000);
  if (current !== generation || token === lastRegisteredToken) return;
  // Remember before POST: a timed-out response does not prove the server did not register it.
  await withDeadline(SecureStore.setItemAsync(TOKEN_KEY, token));
  if (current !== generation) return;
  await apiClient.request("/devices", { method: "POST", body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }) });
  if (current === generation) lastRegisteredToken = token;
}

export async function unregisterPush(): Promise<void> {
  generation += 1;
  if (registration) await withDeadline(registration, 25_000);
  const token = lastRegisteredToken ?? await withDeadline(SecureStore.getItemAsync(TOKEN_KEY));
  if (!token) return;
  // Caller must not report successful logout until this is acknowledged.
  await apiClient.request("/devices", { method: "DELETE", body: JSON.stringify({ expoPushToken: token, platform: Platform.OS }) });
  await withDeadline(SecureStore.deleteItemAsync(TOKEN_KEY));
  lastRegisteredToken = null;
}

export function resetPushRegistrationState(): void {
  generation += 1;
  lastRegisteredToken = null;
}
