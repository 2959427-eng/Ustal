import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, FlatList } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "../src/api/me";
import { getCities } from "../src/api/cities";
import { updateProfile, getPreferences, revokePreference } from "../src/api/profile";
import type { LearnedPreference } from "../src/api/profile";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

const SIGNAL_LABELS: Record<LearnedPreference["signal"], string> = {
  positive: "Показывать чаще",
  negative: "Не показывать подобное",
};

/**
 * Настройки (раздел 27 ТЗ): данные аккаунта (PATCH /profile — раньше
 * нигде не было формы для них) и управление learned_preferences —
 * отмена «не показывать подобное» (GET/DELETE /profile/preferences).
 * Ссылка на заблокированных пользователей (раздел 29 ТЗ) — тоже отсюда.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe });
  const citiesQuery = useQuery({ queryKey: ["cities"], queryFn: getCities });
  const preferencesQuery = useQuery({ queryKey: ["preferences"], queryFn: getPreferences });

  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [cityId, setCityId] = useState<string | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!meQuery.data) return;
    setName(meQuery.data.name);
    setWhatsapp(meQuery.data.whatsappPhone ?? "");
    setCityId(meQuery.data.cityId);
  }, [meQuery.data]);

  const cityName = (id: string | null) => citiesQuery.data?.find((c) => c.id === id)?.name ?? "Не выбран";

  const handleSave = async () => {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      await updateProfile({
        name: name.trim() || undefined,
        cityId: cityId ?? undefined,
        whatsappPhone: whatsapp.trim() ? whatsapp.trim() : null,
      });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Не удалось сохранить.");
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokePreference(id);
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
    } catch {
      // Точечное действие в списке — при сбое просто останется в списке, повторная попытка ниже.
    }
  };

  if (cityPickerOpen) {
    return (
      <View style={styles.container}>
        <Pressable style={styles.back} onPress={() => setCityPickerOpen(false)} hitSlop={12}>
          <Text style={styles.backText}>← Назад</Text>
        </Pressable>
        <Text style={styles.title}>Выберите город</Text>
        {citiesQuery.isLoading && <ActivityIndicator color={colors.primary} />}
        {citiesQuery.data && (
          <FlatList
            data={citiesQuery.data}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <Pressable
                style={styles.cityRow}
                onPress={() => {
                  setCityId(item.id);
                  setCityPickerOpen(false);
                }}
              >
                <Text style={styles.cityRowText}>{item.name}</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <FlatList
        data={preferencesQuery.data ?? []}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={styles.gap}>
            <Text style={styles.title}>Настройки</Text>

            <Text style={styles.sectionTitle}>Аккаунт</Text>
            {meQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View style={styles.gap}>
                <Text style={styles.label}>Имя</Text>
                <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Имя" />
                <Text style={styles.label}>Город</Text>
                <Pressable style={styles.input} onPress={() => setCityPickerOpen(true)}>
                  <Text style={styles.body}>{cityName(cityId)}</Text>
                </Pressable>
                <Text style={styles.label}>WhatsApp (необязательно)</Text>
                <TextInput
                  style={styles.input}
                  value={whatsapp}
                  onChangeText={setWhatsapp}
                  placeholder="+7 900 000-00-00"
                  keyboardType="phone-pad"
                />
                {saveError && <Text style={styles.error}>{saveError}</Text>}
                {saved && <Text style={styles.success}>Сохранено</Text>}
                <PrimaryButton label="Сохранить" onPress={handleSave} loading={saving} />
              </View>
            )}

            <Pressable style={styles.linkRow} onPress={() => router.push("/blocked-users")}>
              <Text style={styles.linkText}>Заблокированные пользователи →</Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Чему научился AI</Text>
            {preferencesQuery.isLoading && <ActivityIndicator color={colors.primary} />}
            {preferencesQuery.data && preferencesQuery.data.length === 0 && (
              <Text style={styles.body}>Пока нет отменённых рекомендаций.</Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.prefRow}>
            <View style={styles.prefInfo}>
              <Text style={styles.prefLabel}>{item.ontologyNodeName ?? "Без названия"}</Text>
              <Text style={styles.prefSignal}>{SIGNAL_LABELS[item.signal]}</Text>
            </View>
            <Pressable onPress={() => handleRevoke(item.id)} hitSlop={8}>
              <Text style={styles.retry}>Отменить</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  gap: { gap: spacing.sm, marginBottom: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  sectionTitle: { ...typography.subtitle, color: colors.textPrimary, marginTop: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary },
  body: { ...typography.body, color: colors.textPrimary },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  error: { ...typography.caption, color: colors.danger },
  success: { ...typography.caption, color: colors.success },
  retry: { ...typography.body, color: colors.primary },
  linkRow: { paddingVertical: spacing.sm },
  linkText: { ...typography.body, color: colors.primary },
  cityRow: { padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.surface, marginBottom: spacing.xs },
  cityRowText: { ...typography.body, color: colors.textPrimary },
  prefRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  prefInfo: { gap: 2 },
  prefLabel: { ...typography.body, color: colors.textPrimary },
  prefSignal: { ...typography.caption, color: colors.textSecondary },
});
