import { Pressable, Text, View, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, radii, shadows, spacing, typography } from "../theme/tokens";

/**
 * Две карточки под вкладками «Возможности» (2026-09-30, по макету): «Мои отклики»
 * (app/responses.tsx) и «История» (общий app/archive.tsx — со стороны исполнителя
 * он называется «История», см. ArchiveLink). Заменяют прежние текстовые ссылки.
 * QuickActionCard используется и на «Заказах» — карточка «Архив заказов».
 */
type IconName = React.ComponentProps<typeof Ionicons>["name"];

export function QuickActionCard({ icon, title, subtitle, href }: { icon: IconName; title: string; subtitle: string; href: Href }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <Ionicons name={icon} size={24} color={colors.primary} />
      <View style={styles.texts}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}

/** «Заказы»: вход в app/archive.tsx только с моими заказами (role=customer, без переключателя ролей). */
export function OrdersQuickActions() {
  return (
    <View style={styles.row}>
      <QuickActionCard icon="archive-outline" title="Архив заказов" subtitle="Завершённые и отменённые" href={{ pathname: "/archive", params: { role: "customer" } }} />
    </View>
  );
}

export function QuickActions() {
  return (
    <View style={styles.row}>
      <QuickActionCard icon="paper-plane-outline" title="Мои отклики" subtitle="Смотреть отклики" href="/responses" />
      <QuickActionCard icon="time-outline" title="История" subtitle="Заказы, которые я выполнял" href={{ pathname: "/archive", params: { role: "executor" } }} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.sm },
  card: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: 12,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    ...shadows.card,
  },
  cardPressed: { backgroundColor: colors.surface },
  texts: { flex: 1, minWidth: 0 },
  title: { ...typography.body, fontWeight: "700", color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
});
