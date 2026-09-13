import { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "../../src/api/me";
import { getProfile, updateProfile } from "../../src/api/profile";
import { getMyOrders, getMyResponses } from "../../src/api/my";
import { logout } from "../../src/api/auth";
import { AvatarPicker } from "../../src/components/AvatarPicker";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

/**
 * «Личный кабинет» — hub-экран (макет Account.dc.html): аватар/имя, плитки
 * со статистикой, «Навыки и ресурсы» (реальный AI-профиль, редактирование —
 * переход в существующий конструктор app/(tabs)/profile.tsx) и список
 * настроек. Открывается по аватарке в HomeHeader. Рейтинг/отзывы в макете
 * есть, но у API нет эндпоинта агрегированного рейтинга — не показываем
 * вымышленные цифры.
 */
export default function AccountScreen() {
  const queryClient = useQueryClient();
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);

  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: getProfile });
  const { data: myOrders } = useQuery({ queryKey: ["my-orders"], queryFn: () => getMyOrders() });
  const { data: myResponses } = useQuery({ queryKey: ["my-responses"], queryFn: () => getMyResponses({ limit: 100 }) });

  const initial = me?.name?.trim()?.[0]?.toUpperCase() ?? "";
  const capabilities = profile?.capabilities ?? [];

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      router.replace("/onboarding");
    } finally {
      setLoggingOut(false);
    }
  };

  // Тап по аватарке (AvatarPicker) уже загрузил файл (POST /media) и
  // вернул mediaId — здесь только привязываем его к профилю
  // (PATCH /profile, см. apps/api/src/routes/profile.ts) и обновляем ["me"],
  // чтобы фото сразу отобразилось и в HomeHeader.
  const onAvatarChange = async (mediaId: string) => {
    setSavingAvatar(true);
    try {
      await updateProfile({ avatarMediaId: mediaId });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setSavingAvatar(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Личный кабинет</Text>
        <Pressable onPress={() => router.push("/settings")} hitSlop={12}>
          <Text style={styles.settingsIcon}>⚙︎</Text>
        </Pressable>
      </View>

      <View style={styles.navTabs}>
        <Pressable style={styles.navTab} onPress={() => router.navigate("/(tabs)")}>
          <Text style={styles.navTabIcon}>💼</Text>
          <Text style={styles.navTabText}>Возможности</Text>
        </Pressable>
        <Pressable style={styles.navTab} onPress={() => router.navigate("/(tabs)/orders")}>
          <Text style={styles.navTabIcon}>📋</Text>
          <Text style={styles.navTabText}>Заказы</Text>
        </Pressable>
      </View>

      <View style={styles.profileCard}>
        <AvatarPicker avatarMediaId={me?.avatarMediaId ?? null} initial={initial} onChange={onAvatarChange} saving={savingAvatar} size={56} />
        <View style={{ flex: 1 }}>
          {meLoading ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.name}>{me?.name ?? "—"}</Text>}
        </View>
      </View>

      <View style={styles.statsRow}>
        <Pressable style={styles.statTile} onPress={() => router.navigate("/(tabs)/orders")}>
          <Text style={styles.statLabel}>Мои заказы</Text>
          <Text style={styles.statValue}>{myOrders?.items.length ?? "—"}</Text>
        </Pressable>
        <Pressable style={styles.statTile} onPress={() => router.push("/(tabs)/responses")}>
          <Text style={styles.statLabel}>Мои отклики</Text>
          <Text style={styles.statValue}>{myResponses?.items.length ?? "—"}</Text>
        </Pressable>
      </View>

      <View style={styles.skillsCard}>
        <View style={styles.skillsHeader}>
          <Text style={styles.sectionTitle}>Навыки и ресурсы</Text>
          <Pressable onPress={() => router.push("/(tabs)/profile")} hitSlop={8}>
            <Text style={styles.editLink}>Изменить</Text>
          </Pressable>
        </View>
        {capabilities.length === 0 ? (
          <Text style={styles.hint}>Пока ничего не рассказали — AI соберёт профиль из голоса или текста.</Text>
        ) : (
          <View style={styles.chipsRow}>
            {capabilities.map((c) => (
              <View key={c.id} style={styles.chip}>
                <Text style={styles.chipText}>{c.label}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.rowsCard}>
        <SettingsRow label="Личные данные" onPress={() => router.push("/settings")} />
        <SettingsRow label="Уведомления" onPress={() => router.push("/notifications")} />
        <SettingsRow label="Заблокированные пользователи" onPress={() => router.push("/blocked-users")} last />
      </View>

      {!confirmingLogout && (
        <Pressable style={styles.logoutButton} onPress={() => setConfirmingLogout(true)}>
          <Text style={styles.logoutText}>Выйти</Text>
        </Pressable>
      )}

      {confirmingLogout && (
        <View style={styles.confirmBox}>
          <Text style={styles.confirmText}>Точно хотите выйти из аккаунта?</Text>
          <View style={styles.confirmRow}>
            <Pressable style={styles.cancelButton} onPress={() => setConfirmingLogout(false)} disabled={loggingOut}>
              <Text style={styles.cancelText}>Отмена</Text>
            </Pressable>
            <Pressable style={styles.confirmButton} onPress={onLogout} disabled={loggingOut}>
              {loggingOut ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.confirmButtonText}>Да, выйти</Text>}
            </Pressable>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function SettingsRow({ label, onPress, last }: { label: string; onPress: () => void; last?: boolean }) {
  return (
    <Pressable style={[styles.settingsRow, !last && styles.settingsRowBorder]} onPress={onPress}>
      <Text style={styles.settingsRowText}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  settingsIcon: { fontSize: 20, color: colors.textPrimary },
  navTabs: { flexDirection: "row", gap: spacing.sm },
  navTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: radii.button,
    backgroundColor: colors.surface,
  },
  navTabIcon: { fontSize: 14 },
  navTabText: { ...typography.body, fontWeight: "700", color: colors.textPrimary },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
  },
  name: { ...typography.title, color: colors.textPrimary },
  statsRow: { flexDirection: "row", gap: spacing.sm },
  statTile: {
    flex: 1,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
    gap: 2,
  },
  statLabel: { ...typography.caption, color: colors.textTertiary },
  statValue: { ...typography.title, fontSize: 20, color: colors.textPrimary },
  skillsCard: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  skillsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  editLink: { ...typography.body, fontWeight: "600", color: colors.primary },
  hint: { ...typography.caption, color: colors.textSecondary },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { backgroundColor: colors.primaryTintBg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 8 },
  chipText: { ...typography.caption, fontWeight: "600", color: colors.primary },
  rowsCard: { borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg, overflow: "hidden" },
  settingsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md },
  settingsRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  settingsRowText: { ...typography.body, color: colors.textPrimary },
  chevron: { fontSize: 18, color: colors.textTertiary },
  logoutButton: { backgroundColor: colors.surface, borderRadius: radii.button, paddingVertical: 15, alignItems: "center" },
  logoutText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  confirmBox: { backgroundColor: "#FBF3F2", borderWidth: 1, borderColor: "#F3DEDC", borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  confirmText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  confirmRow: { flexDirection: "row", gap: spacing.sm },
  cancelButton: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.button,
    paddingVertical: 11,
    alignItems: "center",
  },
  cancelText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  confirmButton: { flex: 1, backgroundColor: colors.danger, borderRadius: radii.button, paddingVertical: 11, alignItems: "center" },
  confirmButtonText: { ...typography.body, fontWeight: "600", color: colors.textInverse },
});
