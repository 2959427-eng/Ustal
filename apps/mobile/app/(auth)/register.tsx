import { getLegalDocuments, registrationDocumentsReady } from "../../src/api/legal";
import { LegalLinks } from "../../src/components/LegalLinks";
import { consumeOrderRoute } from "../../src/notifications/navigation";
import { KeyboardAvoid } from "../../src/components/KeyboardAvoid";
import { useEffect, useState } from "react";
import { Text, TextInput, StyleSheet, ScrollView, View, Pressable } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { CityPicker } from "../../src/components/CityPicker";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { getCities, type City } from "../../src/api/cities";
import { register } from "../../src/api/auth";
import { passwordConfirmError } from "../../src/lib/password-confirm";
import { ensurePushRegistered } from "../../src/notifications/push";

const PHONE_PATTERN = /^\+7\d{10}$/;

/**
 * Регистрация — одним экраном: имя, телефон, пароль и город, кнопка
 * «Зарегистрироваться» сразу вызывает POST /auth/register.
 *
 * 2026-09-13 fix: раньше город выбирался на ОТДЕЛЬНОМ следующем экране
 * (`select-city.tsx`, теперь неиспользуемый — не удаляю сама, файлового
 * доступа к `git rm` у меня нет, см. AI_HANDOFF.md) — эта форма только
 * копила черновик в памяти (`src/state/registrationDraft.ts`, тоже больше
 * не импортируется — пароль намеренно не шёл через query-параметры роута)
 * и переходила дальше отдельным шагом. Пользователь попросил город прямо
 * здесь и одну кнопку регистрации. Паттерн выбора города — тот же, что и
 * в `app/edit-profile.tsx`: поле-кнопка открывает `CityPicker`
 * на весь экран, выбор возвращает обратно в форму.
 */
export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const [documentsReady, setDocumentsReady] = useState(false);
  useEffect(() => { void getLegalDocuments().then(d => setDocumentsReady(registrationDocumentsReady(d))).catch(() => setDocumentsReady(false)); }, []);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [pdnAccepted, setPdnAccepted] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [cityId, setCityId] = useState<string | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [cities, setCities] = useState<City[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [citiesError, setCitiesError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadCities = () => {
    setCitiesLoading(true);
    setCitiesError(false);
    getCities()
      .then(setCities)
      .catch(() => setCitiesError(true))
      .finally(() => setCitiesLoading(false));
  };

  useEffect(() => {
    loadCities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ошибку под полем показываем, как только пользователь начал вводить повтор, либо после попытки отправки.
  const confirmError = passwordConfirmError(password, confirm);
  const showConfirmError = confirmError !== null && (confirm.length > 0 || submitAttempted);

  const cityName = cities.find((c) => c.id === cityId)?.name ?? "Выбрать город";

  const onRegister = async () => {
    if (!__DEV__ && !documentsReady) { setError("Документы ещё не опубликованы — регистрация временно недоступна"); return; }
    if (!ageConfirmed) { setError("Подтвердите, что вам исполнилось 18 лет"); return; }
    if (!rulesAccepted || !pdnAccepted) { setError("Подтвердите условия и обработку данных"); return; }
    if (name.trim().length === 0) {
      setError("Укажите, как к вам обращаться");
      return;
    }
    if (!PHONE_PATTERN.test(phone)) {
      setError("Телефон должен быть в формате +7XXXXXXXXXX");
      return;
    }
    if (password.length < 8) {
      setError("Пароль должен быть не короче 8 символов");
      return;
    }
    if (confirmError) {
      setSubmitAttempted(true);
      setError(null);
      return;
    }
    if (!cityId) {
      setError("Выберите город");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await register({ name: name.trim(), phone, password, cityId, acceptedAge18: true, acceptedRules: true, acceptedPdn: true });
      router.replace(consumeOrderRoute() ?? "/(tabs)");
      void ensurePushRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось завершить регистрацию");
    } finally {
      setSubmitting(false);
    }
  };

  if (cityPickerOpen) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable style={styles.back} onPress={() => setCityPickerOpen(false)} hitSlop={12}>
          <Text style={styles.backText}>← Назад</Text>
        </Pressable>
        <Text style={styles.title}>Выберите город</Text>
        <CityPicker
          cities={cities}
          loading={citiesLoading}
          error={citiesError}
          onRetry={loadCities}
          selectedId={cityId}
          onSelect={(id) => {
            setCityId(id);
            setCityPickerOpen(false);
          }}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoid>
    <ScrollView contentContainerStyle={[styles.container, { paddingTop: insets.top + spacing.sm }]} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Регистрация</Text>

      <Text style={styles.label}>Имя</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Как к вам обращаться" />

      <Text style={styles.label}>Телефон</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoCapitalize="none"
        placeholder="+7XXXXXXXXXX"
      />
      <Text style={styles.hint}>Проверьте номер — он не подтверждается кодом в этой версии приложения.</Text>

      <Text style={styles.label}>Пароль</Text>
      <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />

      <Text style={styles.label}>Повторите пароль</Text>
      <TextInput
        style={[styles.input, showConfirmError && styles.inputError]}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        accessibilityLabel="Повторите пароль"
      />
      {showConfirmError ? <Text style={styles.error}>{confirmError}</Text> : null}

      <Text style={styles.label}>Город</Text>
      <Pressable style={styles.input} onPress={() => setCityPickerOpen(true)} accessibilityRole="button">
        <Text style={cityId ? styles.value : styles.placeholder}>{cityName}</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <LegalLinks />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: rulesAccepted }} disabled={submitting} onPress={() => setRulesAccepted(v => !v)}><Text>{rulesAccepted ? "☑" : "☐"} Принимаю пользовательское соглашение</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: pdnAccepted }} disabled={submitting} onPress={() => setPdnAccepted(v => !v)}><Text>{pdnAccepted ? "☑" : "☐"} Согласен с обработкой персональных данных</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: ageConfirmed }} accessibilityLabel="Мне исполнилось 18 лет" onPress={() => setAgeConfirmed(v => !v)} disabled={submitting}>
        <Text style={styles.hint}>{ageConfirmed ? "☑" : "☐"} Мне исполнилось 18 лет</Text>
      </Pressable>
      <PrimaryButton disabled={!ageConfirmed || !rulesAccepted || !pdnAccepted} label="Зарегистрироваться" onPress={onRegister} loading={submitting} />
    </ScrollView>
    </KeyboardAvoid>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.background, flexGrow: 1 },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  label: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.sm },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  inputError: { borderColor: colors.danger },
  value: { ...typography.body, color: colors.textPrimary },
  placeholder: { ...typography.body, color: colors.textSecondary },
  hint: { ...typography.caption, color: colors.warning, marginBottom: spacing.sm },
  error: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
});
