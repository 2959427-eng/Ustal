import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiClient } from "../api/client";

/**
 * Push-регистрация устройства (POST /devices, Фаза 5 — backend готов давно,
 * но мобильный клиент никогда не вызывал getExpoPushTokenAsync/этот
 * эндпоинт, см. architecture.md §5 п.30). Показывать баннер уведомления,
 * когда приложение открыто на переднем плане — по умолчанию Expo его
 * скрывает, если явно не задать handler.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registrationInFlight = false;
let lastRegisteredToken: string | null = null;

/**
 * Идемпотентно на бэкенде (upsert по expoPushToken) — безопасно звать при
 * каждом запуске приложения для уже вошедшего пользователя, а не только
 * один раз при первом логине (например, после переустановки на другой
 * аккаунт токен должен переписать владельца). Ошибки (нет прав, эмулятор
 * без Google Play Services, отсутствующий EAS projectId до `eas init`) не
 * должны мешать пользоваться остальным приложением — поэтому только логируем.
 */
export async function ensurePushRegistered(): Promise<void> {
  if (registrationInFlight) return;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;

  registrationInFlight = true;
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      // eslint-disable-next-line no-console
      console.log("Push: разрешение на уведомления не получено, регистрация пропущена.");
      return;
    }

    // extra.eas.projectId появится вместе с eas.json после `eas init`
    // (см. architecture.md §5 п.30) — до этого момента SDK может всё равно
    // вернуть Expo push token в managed-режиме разработки, поэтому не
    // блокируем регистрацию на его отсутствии.
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const tokenResponse = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const expoPushToken = tokenResponse.data;

    if (expoPushToken === lastRegisteredToken) return; // уже зарегистрирован в этом запуске

    await apiClient.request("/devices", {
      method: "POST",
      body: JSON.stringify({ expoPushToken, platform: Platform.OS }),
    });
    lastRegisteredToken = expoPushToken;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log("Push: регистрация устройства не удалась (не критично для остального приложения):", err);
  } finally {
    registrationInFlight = false;
  }
}

/** Вызывать при логауте — на следующий вход нужно перерегистрировать токен на нового пользователя. */
export function resetPushRegistrationState(): void {
  lastRegisteredToken = null;
}
