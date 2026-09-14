import { useState } from "react";
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { uploadMedia } from "../api/media";
import { colors, radii, spacing, typography } from "../theme/tokens";

export interface PickedPhoto {
  mediaId: string;
  /** Локальный uri для превью — сам файл уже загружен, сервер знает его только по mediaId. */
  uri: string;
}

interface Props {
  photos: PickedPhoto[];
  onChange: (photos: PickedPhoto[]) => void;
  disabled?: boolean;
  /** POST /orders: mediaIds — максимум 10 (packages/validation/src/orders.ts). */
  max?: number;
}

const MAX_PHOTOS_DEFAULT = 10;

/**
 * Добавление фотографий (раздел 12 ТЗ) — камера или галерея. Каждое фото
 * загружается сразу после выбора (`POST /media`, `kind: "photo"`, тот же
 * эндпоинт, что и для голоса) — в заказ (`createOrder.mediaIds`) уходят уже
 * готовые `mediaId`, а не сырые файлы, так композер не блокируется на
 * отправке заказа ожиданием загрузки фото.
 */
export function PhotoPicker({ photos, onChange, disabled, max = MAX_PHOTOS_DEFAULT }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadAsset = async (asset: ImagePicker.ImagePickerAsset): Promise<PickedPhoto> => {
    const mimeType = asset.mimeType ?? "image/jpeg";
    const name = asset.fileName ?? `photo-${Date.now()}.jpg`;
    const { mediaId } = await uploadMedia("photo", { uri: asset.uri, name, type: mimeType });
    return { mediaId, uri: asset.uri };
  };

  const pickFrom = async (source: "library" | "camera") => {
    const remaining = max - photos.length;
    if (remaining <= 0) return;
    setError(null);
    try {
      const permission =
        source === "library"
          ? await ImagePicker.requestMediaLibraryPermissionsAsync()
          : await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError(source === "library" ? "Нужен доступ к галерее." : "Нужен доступ к камере.");
        return;
      }

      const result =
        source === "library"
          ? await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.8,
              allowsMultipleSelection: true,
              selectionLimit: remaining,
            })
          : await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });

      if (result.canceled || result.assets.length === 0) return;

      setUploading(true);
      // 2026-09-14 fix: раньше весь батч грузился в одном try — если падало
      // ХОТЯ БЫ одно фото (например, второе из нескольких выбранных), catch
      // ловил всё сразу и onChange([...photos, ...uploaded]) вообще не
      // вызывался — терялись и уже успешно загруженные фото тоже, а
      // пользователь видел общую ошибку и не понимал, что часть фото на
      // самом деле загрузилась. Теперь каждое фото грузится в своём try —
      // успешные добавляются в любом случае, ошибка показывается только по
      // упавшим.
      const uploaded: PickedPhoto[] = [];
      let failedCount = 0;
      for (const asset of result.assets.slice(0, remaining)) {
        try {
          uploaded.push(await uploadAsset(asset));
        } catch {
          failedCount += 1;
        }
      }
      if (uploaded.length > 0) {
        onChange([...photos, ...uploaded]);
      }
      if (failedCount > 0) {
        setError(
          uploaded.length > 0
            ? `Не удалось загрузить ${failedCount} из ${result.assets.length} фото. Остальные добавлены — попробуйте загрузить недостающие ещё раз.`
            : "Не удалось загрузить фото. Попробуйте ещё раз.",
        );
      }
    } catch {
      setError("Не удалось загрузить фото. Попробуйте ещё раз.");
    } finally {
      setUploading(false);
    }
  };

  const handleAddPress = () => {
    Alert.alert("Добавить фото", undefined, [
      { text: "Отмена", style: "cancel" },
      { text: "Камера", onPress: () => void pickFrom("camera") },
      { text: "Галерея", onPress: () => void pickFrom("library") },
    ]);
  };

  const removePhoto = (mediaId: string) => onChange(photos.filter((p) => p.mediaId !== mediaId));

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {photos.map((p) => (
          <View key={p.mediaId} style={styles.thumbWrap}>
            <Image source={{ uri: p.uri }} style={styles.thumb} />
            <Pressable
              style={styles.removeButton}
              onPress={() => removePhoto(p.mediaId)}
              disabled={disabled}
              hitSlop={6}
              accessibilityRole="button"
            >
              <Text style={styles.removeText}>×</Text>
            </Pressable>
          </View>
        ))}
        {photos.length < max && (
          <Pressable style={styles.addButton} onPress={handleAddPress} disabled={disabled || uploading} accessibilityRole="button">
            {uploading ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.addIcon}>+</Text>}
          </Pressable>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const THUMB_SIZE = 72;

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  thumbWrap: { width: THUMB_SIZE, height: THUMB_SIZE },
  thumb: { width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt },
  removeButton: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: { color: colors.textInverse, fontSize: 14, lineHeight: 16 },
  addButton: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  addIcon: { ...typography.title, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
});
