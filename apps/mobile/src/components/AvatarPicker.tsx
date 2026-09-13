import { useState } from "react";
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, Alert, Platform } from "react-native";
import { ApiRequestError } from "@ustal/api-client";
import * as ImagePicker from "expo-image-picker";
import { uploadMedia, getMediaUrl } from "../api/media";
import { colors, spacing, typography } from "../theme/tokens";

interface Props {
  avatarMediaId: string | null;
  /** Буква-заглушка, пока фото не выбрано (первая буква имени). */
  initial: string;
  /** Вызывается с mediaId уже ЗАГРУЖЕННОГО файла (POST /media) — сохранение в профиль (PATCH /profile) делает вызывающий экран. */
  onChange: (mediaId: string) => Promise<void> | void;
  /** true, пока вызывающий экран сохраняет mediaId в профиль — блокирует повторный тап. */
  saving?: boolean;
  size?: number;
}

/**
 * Аватар профиля (экран «Личный кабинет», макет Account.dc.html) — тап
 * открывает выбор «Камера / Галерея», тот же паттерн, что и
 * PhotoPicker.tsx (раздел 12 ТЗ, фото заказа): загрузка сразу через
 * POST /media (kind: "photo"), экран уже получает готовый mediaId, а не
 * сырой файл.
 */
export function AvatarPicker({ avatarMediaId, initial, onChange, saving, size = 56 }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = uploading || !!saving;

  const pickFrom = async (source: "library" | "camera") => {
    let stage = "доступ к фото";
    setError(null);
    try {
      const permission = Platform.OS === "web" ? { granted: true } :
        source === "library"
          ? await ImagePicker.requestMediaLibraryPermissionsAsync()
          : await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError(source === "library" ? "Нужен доступ к галерее." : "Нужен доступ к камере.");
        return;
      }

      stage = "выбор и обрезка фото";
      const result =
        source === "library"
          ? await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.8,
              allowsEditing: true,
              aspect: [1, 1],
            })
          : await ImagePicker.launchCameraAsync({
              mediaTypes: ["images"],
              quality: 0.8,
              allowsEditing: true,
              aspect: [1, 1],
            });

      if (result.canceled || result.assets.length === 0) return;

      stage = "подготовка файла";
      const asset = result.assets[0]!;
      setUploading(true);
      const mimeType = asset.mimeType ?? "image/jpeg";
      const name = asset.fileName ?? `avatar-${Date.now()}.jpg`;
      stage = "загрузка на сервер";
      const { mediaId } = await uploadMedia("photo", { uri: asset.uri, name, type: mimeType, file: asset.file });
      stage = "сохранение в профиле";
      await onChange(mediaId);
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        setError(cause.status === 401
          ? "Сессия истекла. Войдите снова и повторите загрузку."
          : cause.code === "invalid_mime_type"
            ? "Этот формат фото не поддерживается. Выберите JPEG, PNG или WebP."
            : cause.status === 413 || cause.code === "file_too_large"
              ? "Фото слишком большое. Выберите файл до 10 МБ."
              : `Не удалось сохранить фото (HTTP ${cause.status}). Попробуйте ещё раз.`);
      } else {
        const detail = (cause instanceof Error ? cause.message : String(cause))
          .replace(/(?:https?|file|content):\/\/\S+/gi, "[адрес скрыт]")
          .replace(/Bearer\s+\S+/gi, "[токен скрыт]")
          .slice(0, 240);
        setError(`Этап: ${stage}. ${detail || "Неизвестная ошибка"}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePress = () => {
    if (busy) return;
    if (Platform.OS === "web") {
      void pickFrom("library");
      return;
    }
    Alert.alert("Фото профиля", undefined, [
      { text: "Отмена", style: "cancel" },
      { text: "Камера", onPress: () => void pickFrom("camera") },
      { text: "Галерея", onPress: () => void pickFrom("library") },
    ]);
  };

  return (
    <View>
      <Pressable
        onPress={handlePress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Изменить фото профиля"
        style={{ width: size, height: size }}
      >
        <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
          {avatarMediaId ? (
            <Image source={{ uri: getMediaUrl(avatarMediaId) }} style={{ width: size, height: size }} />
          ) : (
            <Text style={[styles.avatarText, { fontSize: size * 0.39 }]}>{initial || "•"}</Text>
          )}
          {busy && (
            <View style={styles.overlay}>
              <ActivityIndicator color={colors.textInverse} />
            </View>
          )}
        </View>
        <View style={styles.editBadge}>
          <Text style={styles.editBadgeText}>✎</Text>
        </View>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    backgroundColor: colors.primaryTintBg,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: { fontWeight: "700", color: colors.primary },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  editBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background,
  },
  editBadgeText: { fontSize: 11, color: colors.textInverse },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
});
