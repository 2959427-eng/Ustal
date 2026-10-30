import { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert, TextInput, Image, Platform } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "../../src/api/me";
import { logout } from "../../src/api/auth";
import { getProfile, recognizedLabels, restrictionGroups, updateProfile, type UpdateProfileInput } from "../../src/api/profile";
import { ReputationBlock } from "../../src/components/ReputationBlock";
import { getMyReputation } from "../../src/api/reviews";
import { getCities } from "../../src/api/cities";
import { getMediaUrl } from "../../src/api/media";
import { ProfileBasicsModal } from "../../src/components/ProfileBasicsModal";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ProfileSkillsStatus } from "../../src/components/ProfileSkillsStatus";
import { PROFILE_EMPTY_CTA, profileSkillsView } from "../../src/lib/profile-skills-view";
import { PROFILE_FILL_ROUTE } from "../../src/lib/ai-consent-flow";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

type EditableField = "about" | "whatsapp";

/**
 * Новый интерфейс 2026-10-28: экран стал вкладкой «Профиль» нижней панели, прежние кнопки
 * «Возможности / Заказы» убраны (их заменяет панель). Остальное без изменений.
 *
 * «Мой профиль»: аватар, имя, город, о себе, WhatsApp, навыки и ресурсы (реальный AI-профиль),
 * «Заблокированные пользователи» и «Выйти». Открывается через нижнюю вкладку «Профиль».
 * С 2026-10-06 отдельной кнопки «Изменить профиль» нет: «О себе» и WhatsApp редактируются нажатием прямо на поле
 * (сохранение — «Готово» на клавиатуре или уход с поля). С 2026-10-17 аватар, имя и город — одним окном
 * «Основные данные» по нажатию на верхний блок профиля (ProfileBasicsModal, одно «Сохранить»).
 */
export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: getProfile });
  const profile = profileQuery.data;
  const { data: reputation } = useQuery({ queryKey: ["my-reputation"], queryFn: getMyReputation });
  const queryClient = useQueryClient();
  const citiesQuery = useQuery({ queryKey: ["cities"], queryFn: getCities, staleTime: Infinity });
  const cityName = citiesQuery.data?.find((c) => c.id === me?.cityId)?.name;
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [value, setValue] = useState("");
  const [savingField, setSavingField] = useState<EditableField | null>(null);
  const [basicsOpen, setBasicsOpen] = useState(false);
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
  const skillsView = profileSkillsView({ isLoading: profileQuery.isLoading, isError: profileQuery.isError, hasData: profile !== undefined, labels: { capabilities, resources } });
  const restrictions = restrictionGroups(profile);

  const save = async (field: EditableField, input: UpdateProfileInput) => {
    setSavingField(field);
    try {
      await updateProfile(input);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      return true;
    } catch (err) {
      Alert.alert("Не удалось сохранить", err instanceof Error ? err.message : "Попробуйте ещё раз.");
      return false;
    } finally {
      setSavingField(null);
    }
  };

  const startEdit = (field: EditableField) => {
    setEditing(field);
    setValue((field === "about" ? me?.about : me?.whatsappPhone) ?? "");
  };

  const finishEdit = async () => {
    const field = editing;
    if (!field) return;
    const v = value.trim();
    const current = ((field === "about" ? me?.about : me?.whatsappPhone) ?? "").trim();
    setEditing(null);
    if (v === current) return;
    if (field === "about") await save("about", { about: v || null });
    else await save("whatsapp", { whatsappPhone: v || null });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Мой профиль</Text>
      </View>


      {/* Одна точка редактирования аватара, имени и города (2026-10-17): всё меняется в окне «Основные данные»
          и сохраняется одним действием «Сохранить». */}
      <Pressable
        style={styles.profileCard}
        onPress={() => setBasicsOpen(true)}
        disabled={meLoading || !me}
        accessibilityRole="button"
        accessibilityLabel="Изменить фото, имя и город"
      >
        <View style={styles.avatar}>
          {me?.avatarMediaId ? <Image source={{ uri: getMediaUrl(me.avatarMediaId) }} style={styles.avatarImage} />
            : <Text style={styles.avatarInitial}>{me?.name?.trim()[0]?.toUpperCase() || "•"}</Text>}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          {meLoading ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              <Text style={styles.name}>{me?.name || "Добавить имя"}</Text>
              <Text style={styles.hint}>{cityName ?? "Выбрать город"}</Text>
            </>
          )}
        </View>
      </Pressable>
      {skillsView === "empty" && (
        // Первый экран после регистрации: одно очевидное действие — открыть существующий экран ввода.
        <View style={[styles.skillsCard, styles.ctaCard]} accessibilityLabel="Первый шаг: рассказать о своих возможностях">
          <Text style={styles.ctaTitle} accessibilityRole="header">{PROFILE_EMPTY_CTA.title}</Text>
          <Text style={styles.ctaText}>{PROFILE_EMPTY_CTA.description}</Text>
          <PrimaryButton label={PROFILE_EMPTY_CTA.button} onPress={() => router.push(PROFILE_FILL_ROUTE)} />
          <Text style={styles.ctaCaption}>{PROFILE_EMPTY_CTA.caption}</Text>
          <ProfileSkillsStatus showEditButton={false} />
        </View>
      )}

      <Pressable
        style={styles.skillsCard}
        onPress={() => { if (editing !== "about") startEdit("about"); }}
        accessibilityRole="button"
        accessibilityLabel="Изменить «О себе»"
      >
        <Text style={styles.sectionTitle}>О себе</Text>
        {editing === "about" ? (
          <>
            <TextInput
              style={[styles.aboutText, styles.inlineInput, styles.aboutInput]}
              value={value}
              onChangeText={setValue}
              onBlur={() => { void finishEdit(); }}
              placeholder="Коротко о себе: чем занимаетесь, опыт"
              multiline
              autoFocus
              maxLength={500}
              textAlignVertical="top"
            />
            <View style={styles.inlineFooter}>
              <Text style={styles.hint}>{value.length}/500</Text>
              <Pressable onPress={() => { void finishEdit(); }} hitSlop={8}><Text style={styles.doneText}>Готово</Text></Pressable>
            </View>
          </>
        ) : savingField === "about" ? (
          <Text style={styles.hint}>Сохраняем…</Text>
        ) : me?.about ? (
          <Text style={styles.aboutText}>{me.about}</Text>
        ) : (
          <Text style={styles.hint}>Нажмите, чтобы рассказать о себе</Text>
        )}
      </Pressable>

      <Pressable
        style={styles.skillsCard}
        onPress={() => { if (editing !== "whatsapp") startEdit("whatsapp"); }}
        accessibilityRole="button"
        accessibilityLabel="Изменить WhatsApp"
      >
        <Text style={styles.hint}>WhatsApp</Text>
        {editing === "whatsapp" ? (
          <TextInput
            style={[styles.aboutText, styles.inlineInput]}
            value={value}
            onChangeText={setValue}
            onBlur={() => { void finishEdit(); }}
            onSubmitEditing={() => { void finishEdit(); }}
            returnKeyType="done"
            keyboardType="phone-pad"
            autoFocus
            placeholder="+7 900 000-00-00"
          />
        ) : (
          <Text style={me?.whatsappPhone ? styles.aboutText : styles.hint}>
            {savingField === "whatsapp" ? "Сохраняем…" : me?.whatsappPhone || "Не указан — нажмите, чтобы добавить"}
          </Text>
        )}
      </Pressable>

      {me && (
        <ProfileBasicsModal
          visible={basicsOpen}
          current={{ name: me.name ?? "", cityId: me.cityId ?? null, avatarMediaId: me.avatarMediaId ?? null }}
          cities={citiesQuery.data ?? []}
          citiesLoading={citiesQuery.isLoading}
          citiesError={citiesQuery.isError}
          onRetryCities={() => { void citiesQuery.refetch(); }}
          onClose={() => setBasicsOpen(false)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["me"] })}
        />
      )}

      {skillsView !== "empty" && (
      <View style={styles.skillsCard}>
        <Text style={styles.sectionTitle}>Навыки и ресурсы</Text>
        {/* Раньше здесь были только навыки: профиль с одним ресурсом («есть машина») выглядел пустым. */}
        {skillsView === "loading" ? (
          <View style={styles.skillsStateRow}><ActivityIndicator color={colors.primary} /><Text style={styles.hint}>Загружаем профиль…</Text></View>
        ) : skillsView === "error" ? (
          <View style={{ gap: spacing.xs }}>
            <Text style={styles.hint}>Не удалось загрузить навыки и ресурсы. Проверьте подключение.</Text>
            <PrimaryButton label="Повторить" variant="secondary" onPress={() => { void profileQuery.refetch(); }} />
          </View>
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
        {skillsView === "filled" ? <ProfileSkillsStatus /> : null}
      </View>
      )}

      {/* Явные ограничения пользователя его же словами (время, виды работ, «только …»). Нет — нет раздела. */}
      {restrictions.length > 0 && (
        <View style={styles.skillsCard}>
          <Text style={styles.sectionTitle}>Ограничения</Text>
          {restrictions.map((g) => (
            <View key={g.type} style={{ gap: spacing.xs }}>
              <Text style={styles.hint}>{g.label}</Text>
              {g.items.map((text) => (
                <View key={text} style={styles.restrictionRow}>
                  <Text style={styles.restrictionMark}>⛔</Text>
                  <Text style={styles.restrictionText}>{text}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}

      {reputation && <ReputationBlock reputation={reputation} />}

      <PrimaryButton label="Заблокированные пользователи" variant="secondary" onPress={() => router.push("/blocked-users")} />
      <PrimaryButton label="Написать в поддержку" variant="secondary" onPress={() => router.push("/support")} />
      {Platform.OS !== "android" && (
      <Pressable accessibilityRole="link" onPress={() => router.push("/ai-consent")} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ ...typography.caption, color: colors.textSecondary, textDecorationLine: "underline" }}>Управление согласием ИИ</Text>
      </Pressable>
      )}
      <PrimaryButton label="Удалить аккаунт" variant="secondary" onPress={() => router.push("/delete-account")} />

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
  container: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
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
  inlineInput: { borderBottomWidth: 1, borderColor: colors.primary, paddingVertical: 2 },
  aboutInput: { minHeight: 72 },
  inlineFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  doneText: { ...typography.body, fontWeight: "600", color: colors.primary },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primaryTintBg, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImage: { width: 64, height: 64 },
  avatarInitial: { fontSize: 25, fontWeight: "700", color: colors.primary },
  skillsCard: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary },
  skillsStateRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  ctaCard: { borderColor: colors.primary, borderWidth: 1.5, gap: spacing.md },
  ctaTitle: { ...typography.title, color: colors.textPrimary },
  ctaText: { ...typography.body, color: colors.textSecondary },
  ctaCaption: { ...typography.caption, color: colors.textSecondary, textAlign: "center", marginTop: -spacing.xs },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  restrictionRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.xs },
  restrictionMark: { fontSize: 12, lineHeight: 20 },
  restrictionText: { ...typography.body, color: colors.textPrimary, flex: 1 },
  chip: { backgroundColor: colors.primaryTintBg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 8 },
  chipText: { ...typography.caption, fontWeight: "600", color: colors.primary },
});
