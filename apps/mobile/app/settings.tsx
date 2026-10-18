import { CityPicker } from "../src/components/CityPicker";
import { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "../src/api/me";
import { getCities } from "../src/api/cities";
import { updateProfile } from "../src/api/profile";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/**
 * Настройки → «Личные данные» (раздел 27 ТЗ): данные аккаунта (PATCH
 * /profile — раньше нигде не было формы для них).
 *
 * 2026-09-14 fix (вынесено на уровень профиля): «Заблокированные
 * пользователи» и «Чему научился AI» раньше были вложены сюда — по просьбе
 * пользователя вынесла их из раздела «Личные данные» на уровень «Личного
 * кабинета» (app/(tabs)/account.tsx, rowsCard), рядом с самими «Личными
 * данными», а не внутри них. «Заблокированные пользователи» там уже была
 * отдельной строкой (ссылка отсюда была просто дублем) — убрала дубликат.
 * «Чему научился AI» переехала в новый экран app/ai-preferences.tsx (та же
 * логика запроса/отмены предпочтений, без изменений). Этот экран теперь
 * — только форма личных данных, `FlatList` больше не нужен (список
 * предпочтений отсюда убран) — заменила на `ScrollView`.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe });
  const citiesQuery = useQuery({ queryKey: ["cities"], queryFn: getCities });

  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [cityId, setCityId] = useState<string | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [syncedMeData, setSyncedMeData] = useState<typeof meQuery.data>(undefined);

  // Синхронизируем поля формы с данными аккаунта при их появлении/изменении
  // идентичности объекта (например, после invalidateQueries(["me"]) в
  // handleSave). Вычисляем прямо во время рендера вместо useEffect — паттерн
  // React "adjusting state when a prop changes" (react-hooks/set-state-in-effect).
  if (meQuery.data && meQuery.data !== syncedMeData) {
    setSyncedMeData(meQuery.data);
    setName(meQuery.data.name);
    setWhatsapp(meQuery.data.whatsappPhone ?? "");
    setCityId(meQuery.data.cityId);
  }

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
      router.back();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Не удалось сохранить.");
    } finally {
      setSaving(false);
    }
  };

  if (cityPickerOpen) {
    return (
      <View style={styles.container}>
        <Pressable style={styles.back} onPress={() => setCityPickerOpen(false)} hitSlop={12}>
          <Text style={styles.backText}>← Назад</Text>
        </Pressable>
        <Text style={styles.title}>Выберите город</Text>
        <CityPicker cities={citiesQuery.data ?? []} loading={citiesQuery.isLoading} error={citiesQuery.isError} onRetry={() => { void citiesQuery.refetch(); }} selectedId={cityId} onSelect={(id) => { setCityId(id); setSaved(false); setCityPickerOpen(false); }} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Настройки</Text>

      <Text style={styles.sectionTitle}>Личные данные</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  gap: { gap: spacing.sm },
  title: { ...typography.title, color: colors.textPrimary },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary },
  body: { ...typography.body, color: colors.textPrimary },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  error: { ...typography.caption, color: colors.danger },
  success: { ...typography.caption, color: colors.success },
});
