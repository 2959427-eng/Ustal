import { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { getMe } from "../../src/api/me";
import { logout } from "../../src/api/auth";
import { getProfile, recognizedLabels } from "../../src/api/profile";
import { ReputationBlock } from "../../src/components/ReputationBlock";
import { getMyReputation } from "../../src/api/reviews";
import { getCities } from "../../src/api/cities";
import { AuthorAvatar } from "../../src/components/AuthorAvatar";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

/**
 * «Мой профиль»: аватар, имя, город, о себе, навыки и ресурсы (реальный AI-профиль),
 * «Изменить профиль», «Заблокированные пользователи» и «Выйти» (бывший экран «Настройки» —
 * в нём были только эти два пункта). Открывается по аватарке/имени/городу в HomeHeader.
 */
export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: getProfile });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: getCities, staleTime: Infinity });
  const { data: reputation } = useQuery({ queryKey: ["my-reputation"], queryFn: getMyReputation });
  const cityName = cities?.find((c) => c.id === me?.cityId)?.name;
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      router.replace("/onboarding");
    } catch {
      Alert.alert("Не удалось завершить выход", "Для безопасной отвязки уведомлений и очистки сессии повторите выход при доступной сети.");
    } finally {
      setLoggingOut(false);
    }
  };

  const { capabilities, resources } = recognizedLabels(profile);

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Мой профиль</Text>
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
        <AuthorAvatar name={me?.name ?? ""} avatarMediaId={me?.avatarMediaId ?? null} size={64} />
        <View style={{ flex: 1, gap: 2 }}>
          {meLoading ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.name}>{me?.name ?? "—"}</Text>}
          {!!cityName && <Text style={styles.hint}>{cityName}</Text>}
        </View>
      </View>

      {!!me?.about && (
        <View style={styles.skillsCard}>
          <Text style={styles.sectionTitle}>О себе</Text>
          <Text style={styles.aboutText}>{me.about}</Text>
        </View>
      )}

      <View style={styles.skillsCard}>
        <Text style={styles.sectionTitle}>Навыки и ресурсы</Text>
        {/* Раньше здесь были только навыки: профиль с одним ресурсом («есть машина») выглядел пустым. */}
        {capabilities.length === 0 && resources.length === 0 ? (
          <Text style={styles.hint}>Пока ничего не рассказали — AI соберёт профиль из голоса или текста.</Text>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {capabilities.length > 0 && (
              <View style={{ gap: spacing.xs }}>
                <Text style={styles.hint}>Что я умею</Text>
                <View style={styles.chipsRow}>
                  {capabilities.map((label) => (
                    <View key={label} style={styles.chip}>
                      <Text style={styles.chipText}>{label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {resources.length > 0 && (
              <View style={{ gap: spacing.xs }}>
                <Text style={styles.hint}>Ресурсы</Text>
                <View style={styles.chipsRow}>
                  {resources.map((label) => (
                    <View key={label} style={styles.chip}>
                      <Text style={styles.chipText}>{label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </View>

      {reputation && <ReputationBlock reputation={reputation} />}

      <PrimaryButton label="Изменить профиль" onPress={() => router.push("/edit-profile")} />
      <PrimaryButton label="Заблокированные пользователи" variant="secondary" onPress={() => router.push("/blocked-users")} />

      {!confirmingLogout && (
        <PrimaryButton label="Выйти" variant="secondary" onPress={() => setConfirmingLogout(true)} />
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

const styles = StyleSheet.create({
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
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
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
  aboutText: { ...typography.body, color: colors.textPrimary },
  skillsCard: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { backgroundColor: colors.primaryTintBg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 8 },
  chipText: { ...typography.caption, fontWeight: "600", color: colors.primary },
});
