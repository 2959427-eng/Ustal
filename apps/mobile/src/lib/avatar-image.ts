import { Platform } from "react-native";
import { ApiRequestError } from "@ustal/api-client";
import * as ImagePicker from "expo-image-picker";

/** Выбранная (ещё не загруженная) фотография профиля. */
export interface PickedAvatar {
  uri: string;
  name: string;
  type: string;
  /** web: File из <input type=file> (uploadMedia использует его вместо uri). */
  file?: File;
}

export type PickAvatarResult = { status: "picked"; asset: PickedAvatar } | { status: "canceled" } | { status: "denied"; error: string };

/**
 * Камера/галерея с квадратной обрезкой — общий шаг AvatarPicker и окна «Основные данные»
 * (2026-10-17: вынесено из AvatarPicker без изменения поведения). Файл НЕ загружается.
 */
export async function pickAvatarImage(source: "library" | "camera"): Promise<PickAvatarResult> {
  const permission = Platform.OS === "web" ? { granted: true } :
    source === "library"
      ? await ImagePicker.requestMediaLibraryPermissionsAsync()
      : await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { status: "denied", error: source === "library" ? "Нужен доступ к галерее." : "Нужен доступ к камере." };
  const options = { mediaTypes: ["images"] as ImagePicker.MediaType[], quality: 0.8, allowsEditing: true, aspect: [1, 1] as [number, number] };
  const result = source === "library" ? await ImagePicker.launchImageLibraryAsync(options) : await ImagePicker.launchCameraAsync(options);
  if (result.canceled || result.assets.length === 0) return { status: "canceled" };
  const asset = result.assets[0]!;
  return { status: "picked", asset: { uri: asset.uri, name: asset.fileName ?? `avatar-${Date.now()}.jpg`, type: asset.mimeType ?? "image/jpeg", file: asset.file } };
}

/** Понятное сообщение об ошибке загрузки фото (без адресов файлов и токенов). */
export function avatarErrorMessage(cause: unknown, stage: string): string {
  if (cause instanceof ApiRequestError) {
    return cause.status === 401
      ? `Сессия истекла. Войдите снова и повторите загрузку. (${cause.message})`
      : cause.code === "invalid_mime_type"
        ? "Этот формат фото не поддерживается. Выберите JPEG, PNG или WebP."
        : cause.status === 413 || cause.code === "file_too_large"
          ? "Фото слишком большое. Выберите файл до 10 МБ."
          : `Не удалось сохранить фото (HTTP ${cause.status}). Попробуйте ещё раз.`;
  }
  const detail = (cause instanceof Error ? cause.message : String(cause))
    .replace(/(?:https?|file|content):\/\/\S+/gi, "[адрес скрыт]")
    .replace(/Bearer\s+\S+/gi, "[токен скрыт]")
    .slice(0, 240);
  return `Этап: ${stage}. ${detail || "Неизвестная ошибка"}`;
}
