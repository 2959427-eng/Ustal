import { View, Text, Image, StyleSheet } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { getMediaUrl } from "../api/media";

const PHOTO_SIZE = 104;
const EXTRA_SIZE = 56;

interface Props {
  title: string | null;
  description: string | null;
  photoMediaIds?: string[];
}

/**
 * Шапка заказа: квадратное фото слева, справа заголовок и описание автора
 * (полностью, чтобы при открытии сложного заказа было видно всё). Остальные фото — рядом
 * маленькими квадратами ниже.
 */
export function OrderHeaderBlock({ title, description, photoMediaIds }: Props) {
  const photos = photoMediaIds ?? [];
  const [main, ...extra] = photos;
  const showDescription = !!description && description.trim() !== (title ?? "").trim();
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {main && <Image source={{ uri: getMediaUrl(main) }} style={styles.photo} resizeMode="cover" />}
        <View style={styles.texts}>
          <Text style={styles.title}>{title ?? "Заказ"}</Text>
          {showDescription && <Text style={styles.description}>{description}</Text>}
        </View>
      </View>
      {extra.length > 0 && (
        <View style={styles.extraRow}>
          {extra.map((id) => (
            <Image key={id} source={{ uri: getMediaUrl(id) }} style={styles.extra} resizeMode="cover" />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  photo: { width: PHOTO_SIZE, height: PHOTO_SIZE, aspectRatio: 1, borderRadius: radii.md, backgroundColor: colors.surfaceAlt },
  texts: { flex: 1, gap: spacing.xs },
  title: { ...typography.title, color: colors.textPrimary },
  description: { ...typography.body, color: colors.textSecondary },
  extraRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  extra: { width: EXTRA_SIZE, height: EXTRA_SIZE, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt },
});
