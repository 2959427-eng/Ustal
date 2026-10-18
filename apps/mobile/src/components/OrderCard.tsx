import type { ReactNode } from "react";
import { View, Text, Image, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { getMediaUrl } from "../api/media";
import { colors, radii, spacing, shadows, typography } from "../theme/tokens";

export type MatchType = "exact" | "probable" | "opportunity";

interface Props {
  title: string;
  description: string;
  cityName: string;
  priceMinor: number | null;
  /** Уровни совпадения и пояснение больше не показываются (оставлены в props для совместимости). */
  matchType?: MatchType;
  explanation?: string;
  /** Фото заказа (media id), показываются в карточке. */
  photoMediaIds?: string[];
  /** Раздел 15/17 ТЗ, макет Main.dc.html: прямой отклик с карточки в ленте. */
  responded?: boolean;
  responding?: boolean;
  onRespond?: () => void;
  onHide?: () => void;
  /** Ошибка последней попытки откликнуться — показываем понятным текстом, не проглатываем. */
  respondError?: string | null;
  /** С исполнителем начали переговоры или договорились: вместо «Откликнуться / Скрыть» — статус и кнопки связи. */
  statusLabel?: string;
  contactSlot?: ReactNode;
}

function formatPrice(priceMinor: number | null): string {
  if (priceMinor == null) return "Цена по договорённости";
  return `${Math.round(priceMinor / 100).toLocaleString("ru-RU")} ₽`;
}

/** Карточка заказа в ленте — без счётчика исполнителей (см. docs/screens.md). */
export function OrderCard({
  title,
  cityName,
  priceMinor,
  photoMediaIds,
  responded,
  responding,
  onRespond,
  onHide,
  respondError,
  statusLabel,
  contactSlot,
}: Props) {
  const showActions = !statusLabel && (!!onRespond || !!onHide);
  return (
    <View style={[styles.card, shadows.card]}>
      <View style={styles.row}>
        {photoMediaIds && photoMediaIds.length > 0 && (
          <Image source={{ uri: getMediaUrl(photoMediaIds[0]!) }} style={styles.photo} resizeMode="cover" />
        )}
        <Text style={styles.title} numberOfLines={4}>{title}</Text>
      </View>
      <View style={styles.footer}>
        <Text style={styles.city}>{cityName}</Text>
        <Text style={styles.price}>{formatPrice(priceMinor)}</Text>
      </View>

      {!!statusLabel && <Text style={styles.status}>{statusLabel}</Text>}
      {!!statusLabel && contactSlot}

      {showActions && (
        <View style={styles.actions}>
          {onHide && (
            <Pressable style={({ pressed }) => [styles.actionButton, styles.hideButton, pressed && styles.pressed]} onPress={onHide}>
              <Text style={styles.hideButtonText}>Скрыть</Text>
            </Pressable>
          )}
          {onRespond && (
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                responded ? styles.respondedButton : styles.respondButton,
                pressed && !responded && styles.pressed,
              ]}
              onPress={responded ? undefined : onRespond}
              disabled={responded || responding}
            >
              {responding ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Text style={responded ? styles.respondedButtonText : styles.respondButtonText}>
                  {responded ? "✓ Откликнулся" : "Откликнуться"}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      )}
      {!!respondError && <Text style={styles.respondError}>{respondError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    gap: spacing.xs,
  },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  photo: { width: 88, height: 88, aspectRatio: 1, borderRadius: radii.md, backgroundColor: colors.surface },
  title: { flex: 1, ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  description: { ...typography.body, color: colors.textSecondary },
  footer: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  city: { ...typography.caption, color: colors.textTertiary },
  price: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
  status: { ...typography.body, fontWeight: "700", color: colors.success, marginTop: spacing.xs },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  actionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.button,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.85 },
  hideButton: { backgroundColor: colors.surface },
  hideButtonText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  respondButton: { backgroundColor: colors.primary },
  respondButtonText: { ...typography.body, fontWeight: "700", color: colors.textInverse },
  respondedButton: { backgroundColor: colors.successTintBg },
  respondedButtonText: { ...typography.body, fontWeight: "700", color: colors.success },
  respondError: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
});
