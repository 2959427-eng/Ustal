import { View, Text, Image, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "../api/me";
import { getMediaUrl } from "../api/media";
import { colors, spacing, typography, radii } from "../theme/tokens";

/**
 * Общая шапка «Возможности / Заказы» — раздел 26 ТЗ, макет Main.dc.html.
 * Используется на обоих главных табах: логотип + аватар (переход в профиль)
 * и переключатель с бейджами счётчиков.
 */
export function HomeHeader({
  active,
  opportunitiesCount,
  ordersCount,
}: {
  active: "opportunities" | "orders";
  opportunitiesCount?: number;
  ordersCount?: number;
}) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const initial = me?.name?.trim()?.[0]?.toUpperCase() ?? "";

  return (
    <View style={styles.wrap}>
      <View style={styles.topRow}>
        <Pressable style={styles.avatar} onPress={() => router.push("/(tabs)/account")} hitSlop={8}>
          {me?.avatarMediaId ? (
            <Image source={{ uri: getMediaUrl(me.avatarMediaId) }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{initial || "•"}</Text>
          )}
        </Pressable>
        <View>
          <Text style={styles.logo}>USTAL</Text>
          <Text style={styles.tagline}>Люди. Услуги. Возможности.</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, active === "opportunities" && styles.tabActive]}
          onPress={() => active !== "opportunities" && router.navigate("/(tabs)")}
        >
          <Text style={styles.tabIcon}>💼</Text>
          <Text style={[styles.tabText, active === "opportunities" && styles.tabTextActive]}>Возможности</Text>
          {!!opportunitiesCount && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{opportunitiesCount}</Text>
            </View>
          )}
        </Pressable>
        <Pressable
          style={[styles.tab, active === "orders" && styles.tabActive]}
          onPress={() => active !== "orders" && router.navigate("/(tabs)/orders")}
        >
          <Text style={styles.tabIcon}>📋</Text>
          <Text style={[styles.tabText, active === "orders" && styles.tabTextActive]}>Заказы</Text>
          {!!ordersCount && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{ordersCount}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  topRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  logo: { fontSize: 22, fontWeight: "800", color: colors.textPrimary, letterSpacing: -0.4 },
  tagline: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: 40, height: 40 },
  avatarText: { ...typography.body, fontWeight: "700", color: colors.textSecondary },
  tabs: { flexDirection: "row", gap: spacing.sm },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: radii.button,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.primary },
  tabIcon: { fontSize: 14 },
  tabText: { ...typography.body, fontWeight: "700", color: colors.textPrimary },
  tabTextActive: { color: colors.textInverse },
  badge: {
    marginLeft: 2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: colors.badge,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 11, fontWeight: "700", color: colors.textInverse },
});
