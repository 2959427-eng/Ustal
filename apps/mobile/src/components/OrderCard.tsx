import { View, Text, StyleSheet } from "react-native";
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
}

function formatPrice(priceMinor: number | null): string {
  if (priceMinor == null) return "Цена по договорённости";
  return `${Math.round(priceMinor / 100).toLocaleString("ru-RU")} ₽`;
}

/** Карточка заказа в ленте — без счётчика исполнителей (см. docs/screens.md). */
export function OrderCard({ title, description, cityName, priceMinor, matchType, explanation }: Props) {
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.background, borderRadius: radii.lg, padding: spacing.md, gap: spacing.xs },
  badge: { alignSelf: "flex-start", borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  badgeText: { ...typography.caption, color: colors.textInverse },
  title: { ...typography.subtitle, color: colors.textPrimary },
  description: { ...typography.body, color: colors.textSecondary },
  footer: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs },
  city: { ...typography.caption, color: colors.textSecondary },
  price: { ...typography.subtitle, color: colors.textPrimary },
  explanation: { ...typography.caption, color: colors.primary, marginTop: spacing.xs },
});
