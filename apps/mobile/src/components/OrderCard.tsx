import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { colors, radii, spacing, shadows, typography } from "../theme/tokens";

export type MatchType = "exact" | "probable" | "new_opportunity";

const MATCH_LABELS: Record<MatchType, string> = {
  exact: "Точное совпадение",
  probable: "Вероятное совпадение",
  new_opportunity: "Новая возможность",
};

const MATCH_COLORS: Record<MatchType, string> = {
  exact: colors.matchExact,
  probable: colors.matchProbable,
  new_opportunity: colors.matchNewOpportunity,
};

interface Props {
  title: string;
  description: string;
  cityName: string;
  priceMinor: number | null;
  matchType?: MatchType;
  explanation?: string;
  /** Раздел 15/17 ТЗ, макет Main.dc.html: прямой отклик с карточки в ленте. */
  responded?: boolean;
  responding?: boolean;
  onRespond?: () => void;
  onHide?: () => void;
}

function formatPrice(priceMinor: number | null): string {
  if (priceMinor == null) return "Цена по договорённости";
  return `${Math.round(priceMinor / 100).toLocaleString("ru-RU")} ₽`;
}

/** Карточка заказа в ленте — без счётчика исполнителей (см. docs/screens.md). */
export function OrderCard({
  title,
  description,
  cityName,
  priceMinor,
  matchType,
  explanation,
  responded,
  responding,
  onRespond,
  onHide,
}: Props) {
  const showActions = !!onRespond || !!onHide;
  return (
    <View style={[styles.card, shadows.card]}>
      {matchType && (
        <View style={[styles.badge, { backgroundColor: MATCH_COLORS[matchType] }]}>
          <Text style={styles.badgeText}>{MATCH_LABELS[matchType]}</Text>
        </View>
      )}
      <Text style={styles.title} numberOfLines={2}>{title}</Text>
      <Text style={styles.description} numberOfLines={3}>{description}</Text>
      <View style={styles.footer}>
        <Text style={styles.city}>{cityName}</Text>
        <Text style={styles.price}>{formatPrice(priceMinor)}</Text>
      </View>
      {explanation && <Text style={styles.explanation}>{explanation}</Text>}

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
  badge: { alignSelf: "flex-start", borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  badgeText: { ...typography.caption, fontWeight: "600", color: colors.textInverse },
  title: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  description: { ...typography.body, color: colors.textSecondary },
  footer: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  city: { ...typography.caption, color: colors.textTertiary },
  price: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
  explanation: { ...typography.caption, color: colors.primary, marginTop: spacing.xs },
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
});
