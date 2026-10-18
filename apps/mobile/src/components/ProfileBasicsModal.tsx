import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Image, Pressable, Modal, ScrollView, StyleSheet, Alert, Platform, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { City } from "../api/cities";
import { getMediaUrl, uploadMedia } from "../api/media";
import { updateProfile } from "../api/profile";
import { avatarErrorMessage, pickAvatarImage, type PickedAvatar } from "../lib/avatar-image";
import { buildProfileBasicsPatch, PROFILE_NAME_MAX, type ProfileBasics } from "../lib/profile-basics";
import { CityPicker } from "./CityPicker";
import { KeyboardAvoid } from "./KeyboardAvoid";
import { PrimaryButton } from "./PrimaryButton";
import { colors, spacing, typography, radii } from "../theme/tokens";

interface Props {
  visible: boolean;
  current: ProfileBasics;
  cities: City[];
  citiesLoading: boolean;
  citiesError: boolean;
  onRetryCities: () => void;
  onClose: () => void;
  /** После успешного PATCH /profile — обновить данные профиля у вызывающего экрана. */
  onSaved: () => Promise<void> | void;
}

/**
 * «Основные данные» (2026-10-17): одна точка редактирования аватара, имени и города. Значения предзаполнены;
 * до «Сохранить» ничего не отправляется (новое фото только выбирается локально); «Сохранить» загружает фото
 * (POST /media, как и прежде) и отправляет ВСЕ изменения одним PATCH /profile. Ошибка — форма остаётся открытой.
 */
export function ProfileBasicsModal({ visible, current, cities, citiesLoading, citiesError, onRetryCities, onClose, onSaved }: Props) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(current.name);
  const [cityId, setCityId] = useState<string | null>(current.cityId);
  const [avatar, setAvatar] = useState<PickedAvatar | null>(null);
  const [choosingCity, setChoosingCity] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Фото уже загружено, а PATCH не прошёл — повторное «Сохранить» не загружает тот же файл второй раз.
  const uploaded = useRef<{ uri: string; mediaId: string } | null>(null);

  // Каждое открытие — с текущими сохранёнными значениями.
  useEffect(() => {
    if (!visible) return;
    setName(current.name);
    setCityId(current.cityId);
    setAvatar(null);
    uploaded.current = null;
    setChoosingCity(false);
    setError(null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const cityName = cities.find((c) => c.id === cityId)?.name;

  const choosePhoto = async (source: "library" | "camera") => {
    setError(null);
    try {
      const picked = await pickAvatarImage(source);
      if (picked.status === "denied") setError(picked.error);
      else if (picked.status === "picked") setAvatar(picked.asset);
    } catch (cause) {
      setError(avatarErrorMessage(cause, "выбор и обрезка фото"));
    }
  };
  const onAvatarPress = () => {
    if (saving) return;
    if (Platform.OS === "web") { void choosePhoto("library"); return; }
    Alert.alert("Фото профиля", undefined, [
      { text: "Отмена", style: "cancel" },
      { text: "Камера", onPress: () => void choosePhoto("camera") },
      { text: "Галерея", onPress: () => void choosePhoto("library") },
    ]);
  };

  const onSave = async () => {
    const check = buildProfileBasicsPatch(current, { name, cityId });
    if (!check.ok) { setError(check.error); return; }
    setSaving(true);
    setError(null);
    let stage = "загрузка фото";
    try {
      let avatarMediaId: string | undefined;
      if (avatar) {
        if (uploaded.current?.uri !== avatar.uri) uploaded.current = { uri: avatar.uri, mediaId: (await uploadMedia("photo", avatar)).mediaId };
        avatarMediaId = uploaded.current.mediaId;
      }
      const final = buildProfileBasicsPatch(current, { name, cityId, avatarMediaId });
      if (final.ok && final.patch) {
        stage = "сохранение профиля";
        await updateProfile(final.patch);
        await onSaved();
      }
      onClose();
    } catch (cause) {
      setError(stage === "загрузка фото" ? avatarErrorMessage(cause, stage)
        : `Не удалось сохранить: ${cause instanceof Error ? cause.message : "попробуйте ещё раз."}`);
    } finally {
      setSaving(false);
    }
  };

  const close = () => { if (!saving) onClose(); };
  const initial = name.trim()[0]?.toUpperCase() ?? "";
  const avatarUri = avatar?.uri ?? (current.avatarMediaId ? getMediaUrl(current.avatarMediaId) : null);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoid style={[styles.container, { paddingTop: spacing.lg, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          {choosingCity ? (
            <>
              <Text style={styles.title}>Выберите город</Text>
              <Pressable onPress={() => setChoosingCity(false)} hitSlop={12}><Text style={styles.link}>Назад</Text></Pressable>
            </>
          ) : (
            <>
              <Text style={styles.title}>Основные данные</Text>
              <Pressable onPress={close} hitSlop={12} disabled={saving}><Text style={styles.link}>Отмена</Text></Pressable>
            </>
          )}
        </View>

        {choosingCity ? (
          <CityPicker
            cities={cities}
            loading={citiesLoading}
            error={citiesError}
            onRetry={onRetryCities}
            selectedId={cityId}
            onSelect={(id) => { setCityId(id); setChoosingCity(false); }}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <Pressable style={styles.avatarRow} onPress={onAvatarPress} disabled={saving} accessibilityRole="button" accessibilityLabel="Заменить фото профиля">
              <View style={styles.avatar}>
                {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatarImage} /> : <Text style={styles.avatarInitial}>{initial || "•"}</Text>}
              </View>
              <Text style={styles.link}>{avatarUri ? "Заменить фото" : "Добавить фото"}</Text>
            </Pressable>

            <Text style={styles.label}>Имя</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={(v) => { setName(v); setError(null); }}
              placeholder="Имя"
              maxLength={PROFILE_NAME_MAX}
              editable={!saving}
              returnKeyType="done"
            />

            <Text style={styles.label}>Город</Text>
            <Pressable style={styles.input} onPress={() => setChoosingCity(true)} disabled={saving} accessibilityRole="button" accessibilityLabel="Выбрать город">
              {citiesLoading && !cityName ? <ActivityIndicator color={colors.primary} />
                : <Text style={cityName ? styles.value : styles.placeholder}>{cityName ?? "Выбрать город"}</Text>}
            </Pressable>

            {error && <Text style={styles.error}>{error}</Text>}
            <PrimaryButton label="Сохранить" onPress={() => { void onSave(); }} loading={saving} />
          </ScrollView>
        )}
      </KeyboardAvoid>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  title: { ...typography.subtitle, color: colors.textPrimary },
  link: { ...typography.body, color: colors.primary },
  form: { gap: spacing.sm, paddingBottom: spacing.lg },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.sm },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primaryTintBg, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImage: { width: 72, height: 72 },
  avatarInitial: { fontSize: 28, fontWeight: "700", color: colors.primary },
  label: { ...typography.caption, color: colors.textSecondary, fontWeight: "600", marginTop: spacing.xs },
  input: { ...typography.body, color: colors.textPrimary, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, minHeight: 48, justifyContent: "center" },
  value: { ...typography.body, color: colors.textPrimary },
  placeholder: { ...typography.body, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
});
