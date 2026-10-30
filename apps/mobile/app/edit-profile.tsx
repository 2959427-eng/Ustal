import { CityPicker } from "../src/components/CityPicker";
import { useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "../src/api/me";
import { getCities } from "../src/api/cities";
import { getProfile, getProfileDraft, recognizedLabels, updateProfile } from "../src/api/profile";
import { AvatarPicker } from "../src/components/AvatarPicker";
import { KeyboardAvoid } from "../src/components/KeyboardAvoid";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/**
 * «Изменить профиль»: аватар, имя, город, о себе, WhatsApp (PATCH /profile)
 * и переход к навыкам и ресурсам (конструктор app/(tabs)/profile.tsx).
 *
 * «О себе» — просто описание (в т.ч. для компаний), в AI-разбор навыков НЕ отправляется.
 * Навыки и ресурсы — только через экран «Изменить навыки и ресурсы».
 */
export default function EditProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe });
  const citiesQuery = useQuery({ queryKey: ["cities"], queryFn: getCities });
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: getProfile });
  const draftQuery = useQuery({ queryKey: ["profileDraft"], queryFn: getProfileDraft });
  const draft = draftQuery.data?.draft ? draftQuery.data : null;

  const [name, setName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [about, setAbout] = useState("");
  const [cityId, setCityId] = useState<string | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [syncedMeData, setSyncedMeData] = useState<typeof meQuery.data>(undefined);

  // Синхронизируем поля формы с данными аккаунта при их появлении/изменении
  // (паттерн React "adjusting state when a prop changes", без useEffect).
  if (meQuery.data && meQuery.data !== syncedMeData) {
    setSyncedMeData(meQuery.data);
    setName(meQuery.data.name);
    setWhatsapp(meQuery.data.whatsappPhone ?? "");
    setAbout(meQuery.data.about ?? "");
    setCityId(meQuery.data.cityId);
  }

  const cityName = (id: string | null) => citiesQuery.data?.find((c) => c.id === id)?.name ?? "Не выбран";
  const { capabilities, resources } = recognizedLabels(profileQuery.data);
  const draftHasChanges =
    !!draft &&
    (draft.diff.addedCapabilities.length > 0 ||
      draft.diff.addedResources.length > 0 ||
      (draft.diff.addedUnmapped ?? []).length > 0 ||
      draft.diff.removedCapabilities.length > 0 ||
      draft.diff.removedResources.length > 0);

  const handleSave = async () => {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      await updateProfile({
        name: name.trim() || undefined,
        cityId: cityId ?? undefined,
        whatsappPhone: whatsapp.trim() ? whatsapp.trim() : null,
        about: about.trim() ? about.trim() : null,
      });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setSaved(true);
      router.back();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Не удалось сохранить.");
    } finally {
      setSaving(false);
    }
  };

  // AvatarPicker уже загрузил файл (POST /media) — здесь только привязываем mediaId к профилю.
  const handleAvatarChange = async (mediaId: string) => {
    setSavingAvatar(true);
    try {
      await updateProfile({ avatarMediaId: mediaId });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } finally {
      setSavingAvatar(false);
    }
  };

  if (cityPickerOpen) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable style={styles.back} onPress={() => setCityPickerOpen(false)} hitSlop={12}>
          <Text style={styles.backText}>← Назад</Text>
        </Pressable>
        <Text style={styles.title}>Выберите город</Text>
        <CityPicker cities={citiesQuery.data ?? []} loading={citiesQuery.isLoading} error={citiesQuery.isError} onRetry={() => { void citiesQuery.refetch(); }} selectedId={cityId} onSelect={(id) => { setCityId(id); setSaved(false); setCityPickerOpen(false); }} />
      </View>
    );
  }

  return (
    <KeyboardAvoid style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.title}>Изменить профиль</Text>
        {meQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <View style={styles.gap}>
            <View style={styles.avatarRow}>
              <AvatarPicker
                avatarMediaId={meQuery.data?.avatarMediaId ?? null}
                initial={name.trim()[0]?.toUpperCase() ?? ""}
                onChange={handleAvatarChange}
                saving={savingAvatar}
                size={72}
              />
              <Text style={styles.hintText}>Нажмите на фото, чтобы изменить</Text>
            </View>

            <Text style={styles.label}>Имя</Text>
            <TextInput style={styles.input} value={name} onChangeText={(v) => { setName(v); setSaved(false); }} placeholder="Имя" />

            <Text style={styles.label}>Город</Text>
            <Pressable style={styles.input} onPress={() => setCityPickerOpen(true)}>
              <Text style={styles.body}>{cityName(cityId)}</Text>
            </Pressable>

            <Text style={styles.label}>О себе (необязательно)</Text>
            <TextInput
              style={[styles.input, styles.aboutInput]}
              value={about}
              onChangeText={(v) => { setAbout(v); setSaved(false); }}
              placeholder="Коротко о себе: чем занимаетесь, опыт, что умеете"
              multiline
              maxLength={500}
              textAlignVertical="top"
            />
            <Text style={styles.hintText}>{about.length}/500</Text>

            <Text style={styles.label}>WhatsApp (необязательно)</Text>
            <TextInput
              style={styles.input}
              value={whatsapp}
              onChangeText={(v) => { setWhatsapp(v); setSaved(false); }}
              placeholder="+7 900 000-00-00"
              keyboardType="phone-pad"
            />

            <Text style={styles.sectionTitle}>Навыки и ресурсы</Text>
            {draftHasChanges && (
              <View style={styles.draftBox}>
                <Text style={styles.draftTitle}>AI собрал навыки — проверьте и примените</Text>
                <PrimaryButton label="Проверить и применить" onPress={() => router.navigate("/(tabs)/profile")} />
              </View>
            )}
            {capabilities.length > 0 || resources.length > 0 ? (
              <View style={styles.chipsRow}>
                {[...new Set([...capabilities, ...resources])].map((label) => (
                  <View key={label} style={styles.chip}><Text style={styles.chipText}>{label}</Text></View>
                ))}
              </View>
            ) : (
              !draftHasChanges && (
                <Text style={styles.hintText}>Пока ничего не рассказали — AI соберёт профиль из голоса или текста.</Text>
              )
            )}

            {saveError && <Text style={styles.error}>{saveError}</Text>}
            {saved && <Text style={styles.success}>Сохранено</Text>}
            <PrimaryButton label="Сохранить" onPress={handleSave} loading={saving} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoid>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, padding: spacing.lg },
  content: { paddingBottom: spacing.xxl },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  gap: { gap: spacing.sm, marginTop: spacing.md },
  title: { ...typography.title, fontSize: 28, lineHeight: 34, color: colors.textPrimary },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary },
  hintText: { ...typography.caption, color: colors.textSecondary },
  draftBox: { backgroundColor: colors.primaryTintBg, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  draftTitle: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  aboutInput: { minHeight: 96, paddingTop: spacing.sm },
  body: { ...typography.body, color: colors.textPrimary },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { backgroundColor: colors.primaryTintBg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 8 },
  chipText: { ...typography.caption, fontWeight: "600", color: colors.primary },
  error: { ...typography.caption, color: colors.danger },
  success: { ...typography.caption, color: colors.success },
});
