import { consumeOrderRoute } from "../../src/notifications/navigation";
import { KeyboardAvoid } from "../../src/components/KeyboardAvoid";
import { useEffect, useState } from "react";
import { Text, TextInput, StyleSheet, ScrollView, View, Pressable, Linking } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { CityPicker } from "../../src/components/CityPicker";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { getCities, type City } from "../../src/api/cities";
import { register } from "../../src/api/auth";
import { passwordConfirmError } from "../../src/lib/password-confirm";
import { ensurePushRegistered } from "../../src/notifications/push";
import { ConsentCheckbox } from "../../src/components/ConsentCheckbox";
import { getLegalDocuments, legalDocumentUrl, registrationDocumentsReady, type LegalDocumentId } from "../../src/api/legal";
import { registrationConsentError } from "../../src/lib/registration-consent";

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
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [acceptedPdn, setAcceptedPdn] = useState(false);
  const [documentsReady, setDocumentsReady] = useState(false);

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
    getLegalDocuments().then((docs) => setDocumentsReady(registrationDocumentsReady(docs))).catch(() => setDocumentsReady(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ошибку под полем показываем, как только пользователь начал вводить повтор, либо после попытки отправки.
  const confirmError = passwordConfirmError(password, confirm);
  const showConfirmError = confirmError !== null && (confirm.length > 0 || submitAttempted);

  const openDocument = (id: LegalDocumentId) => { void Linking.openURL(legalDocumentUrl(id)); };

  const cityName = cities.find((c) => c.id === cityId)?.name ?? "Выбрать город";

  const onRegister = async () => {
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
    // В сборке разработчика (локальный API без опубликованных документов) отметки всё равно обязательны.
    const consentError = registrationConsentError({ acceptedRules, acceptedPdn, documentsReady, allowUnpublished: __DEV__ });
    if (consentError) {
      setError(consentError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await register({ name: name.trim(), phone, password, cityId, acceptedRules: true, acceptedPdn: true });
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

      <ConsentCheckbox checked={acceptedRules} onChange={setAcceptedRules}>
        Принимаю <Text style={styles.link} onPress={() => openDocument("terms")}>пользовательское соглашение</Text> и{" "}
        <Text style={styles.link} onPress={() => openDocument("privacy")}>политику обработки персональных данных</Text>
      </ConsentCheckbox>
      <ConsentCheckbox checked={acceptedPdn} onChange={setAcceptedPdn}>
        Согласен на обработку моих персональных данных в соответствии с{" "}
        <Text style={styles.link} onPress={() => openDocument("privacy")}>политикой</Text>
      </ConsentCheckbox>
      {!documentsReady && !__DEV__ ? <Text style={styles.hint}>Документы ещё не опубликованы — регистрация временно недоступна.</Text> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <PrimaryButton label="Зарегистрироваться" onPress={onRegister} loading={submitting} disabled={!acceptedRules || !acceptedPdn || (!documentsReady && !__DEV__)} />
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
  link: { color: colors.primary, textDecorationLine: "underline" },
});
