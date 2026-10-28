import { getLegalDocuments, registrationDocumentsReady } from "../../src/api/legal";
import { LegalDocumentModal } from "../../src/components/LegalDocumentModal";
import type { LegalPage } from "../../src/lib/legal-links";
import { postRegistrationRoute } from "../../src/lib/ai-consent-flow";
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
import { formatPhoneDigits, isCompletePhone, phoneDigitsFromInput, phoneFromDigits } from "../../src/lib/phone-input";
import { ensurePushRegistered } from "../../src/notifications/push";

/**
 * Регистрация — один компактный экран: имя, телефон (+7 фиксирован), пароль с показом, город,
 * две обязательные активные отметки и одна кнопка. POST /auth/register и его поля не менялись:
 * сервер не требует повтора пароля; acceptedRules, acceptedPdn и acceptedAge18 отправляются как раньше.
 * Согласие на обработку ПДн — отдельной отметкой (не вместе с соглашением).
 * Документы открываются во встроенном окне (LegalDocumentModal), форма при этом не сбрасывается.
 * Полный список документов, поддержка и удаление аккаунта — на экране входа и в «Аккаунт».
 */
export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const [documentsReady, setDocumentsReady] = useState(false);
  useEffect(() => { void getLegalDocuments().then(d => setDocumentsReady(registrationDocumentsReady(d))).catch(() => setDocumentsReady(false)); }, []);
  // Одна активная отметка: соглашение + 18+ (обе подтверждаются осознанно); отдельная — согласие на ПДн.
  const [termsAndAge, setTermsAndAge] = useState(false);
  const [pdnAccepted, setPdnAccepted] = useState(false);
  const [name, setName] = useState("");
  const [phoneDigits, setPhoneDigits] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cityId, setCityId] = useState<string | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [cities, setCities] = useState<City[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [citiesError, setCitiesError] = useState(false);
  const [doc, setDoc] = useState<LegalPage | null>(null);
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

  const cityName = cities.find((c) => c.id === cityId)?.name;

  const onRegister = async () => {
    if (!__DEV__ && !documentsReady) { setError("Документы ещё не опубликованы — регистрация временно недоступна"); return; }
    if (!termsAndAge) { setError("Подтвердите, что вам исполнилось 18 лет, и примите соглашение"); return; }
    if (!pdnAccepted) { setError("Нужно согласие на обработку персональных данных"); return; }
    if (name.trim().length === 0) { setError("Укажите, как к вам обращаться"); return; }
    if (!isCompletePhone(phoneDigits)) { setError("Введите 10 цифр номера после +7"); return; }
    if (password.length < 8) { setError("Пароль должен быть не короче 8 символов"); return; }
    if (!cityId) { setError("Выберите город"); return; }
    setError(null);
    setSubmitting(true);
    try {
      await register({ name: name.trim(), phone: phoneFromDigits(phoneDigits), password, cityId, acceptedAge18: true, acceptedRules: true, acceptedPdn: true });
      // Сразу в приложение; окно «Как работает USTAL» — при первом заполнении профиля, до первой ИИ-обработки.
      router.replace(postRegistrationRoute(consumeOrderRoute()));
      void ensurePushRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось завершить регистрацию");
    } finally {
      setSubmitting(false);
    }
  };

  if (cityPickerOpen) {
    return (
      <View style={[styles.pickerContainer, { paddingTop: insets.top + spacing.sm }]}>
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

  const link = (page: LegalPage, label: string) => (
    <Text style={styles.link} accessibilityRole="link" onPress={() => setDoc(page)} suppressHighlighting>{label}</Text>
  );

  return (
    <KeyboardAvoid>
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.lg }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Назад">
        <Text style={styles.backText}>←</Text>
      </Pressable>
      <Text style={styles.title}>Регистрация</Text>

      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Как к вам обращаться"
        placeholderTextColor={colors.textTertiary}
        accessibilityLabel="Имя"
        autoComplete="name"
        textContentType="name"
        returnKeyType="next"
        editable={!submitting}
      />

      <View style={styles.row}>
        <Text style={styles.prefix}>+7</Text>
        <TextInput
          style={styles.rowInput}
          value={formatPhoneDigits(phoneDigits)}
          onChangeText={(t) => setPhoneDigits(phoneDigitsFromInput(t))}
          keyboardType="phone-pad"
          placeholder="900 123-45-67"
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel="Телефон, 10 цифр после +7"
          autoComplete="tel"
          textContentType="telephoneNumber"
          editable={!submitting}
        />
      </View>
      <Text style={styles.note}>Номер пока не подтверждается по SMS — проверьте его: по нему вы будете входить.</Text>

      <View style={styles.row}>
        <TextInput
          style={styles.rowInput}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          placeholder="Пароль, не короче 8 символов"
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel="Пароль"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          editable={!submitting}
        />
        <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={10} accessibilityRole="button"
          accessibilityLabel={showPassword ? "Скрыть пароль" : "Показать пароль"}>
          <Text style={styles.toggle}>{showPassword ? "Скрыть" : "Показать"}</Text>
        </Pressable>
      </View>

      <Pressable style={styles.input} onPress={() => setCityPickerOpen(true)} accessibilityRole="button" accessibilityLabel={cityName ? `Город: ${cityName}` : "Выбрать город"} disabled={submitting}>
        <Text style={cityName ? styles.value : styles.placeholder}>{cityName ?? "Город"}</Text>
      </Pressable>

      <View style={styles.legal}>
        <Pressable style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: termsAndAge }}
          accessibilityLabel="Мне есть 18 лет, принимаю Пользовательское соглашение" disabled={submitting} onPress={() => setTermsAndAge((v) => !v)} hitSlop={4}>
          <Text style={[styles.box, termsAndAge && styles.boxOn]}>{termsAndAge ? "✓" : ""}</Text>
          <Text style={styles.checkText}>Мне есть 18 лет, принимаю {link("terms", "Пользовательское соглашение")}</Text>
        </Pressable>
        <Pressable style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: pdnAccepted }}
          accessibilityLabel="Согласен на обработку персональных данных по Политике конфиденциальности" disabled={submitting} onPress={() => setPdnAccepted((v) => !v)} hitSlop={4}>
          <Text style={[styles.box, pdnAccepted && styles.boxOn]}>{pdnAccepted ? "✓" : ""}</Text>
          <Text style={styles.checkText}>Согласен(на) на обработку персональных данных по {link("privacy", "Политике конфиденциальности")}</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <PrimaryButton disabled={!termsAndAge || !pdnAccepted} label="Зарегистрироваться" onPress={onRegister} loading={submitting} />

      <Pressable style={styles.login} onPress={() => router.replace("/(auth)/login")} accessibilityRole="link" hitSlop={8}>
        <Text style={styles.loginText}>Уже есть аккаунт? <Text style={styles.link}>Войти</Text></Text>
      </Pressable>
      <LegalDocumentModal page={doc} onClose={() => setDoc(null)} />
    </ScrollView>
    </KeyboardAvoid>
  );
}

const field = { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.md } as const;
const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg, gap: spacing.sm, backgroundColor: colors.background, flexGrow: 1 },
  pickerContainer: { flex: 1, padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.background },
  back: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  backText: { fontSize: 22, color: colors.textPrimary },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  input: { ...typography.body, ...field, justifyContent: "center", color: colors.textPrimary },
  row: { ...field, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowInput: { ...typography.body, flex: 1, minHeight: 46, color: colors.textPrimary },
  prefix: { ...typography.body, color: colors.textPrimary },
  toggle: { ...typography.caption, color: colors.primary, fontWeight: "600" },
  note: { ...typography.caption, color: colors.textSecondary, marginTop: -spacing.xs },
  value: { ...typography.body, color: colors.textPrimary },
  placeholder: { ...typography.body, color: colors.textTertiary },
  legal: { gap: spacing.sm, marginTop: spacing.xs },
  check: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, minHeight: 32 },
  box: { width: 22, height: 22, borderWidth: 1.5, borderColor: colors.border, borderRadius: 6, textAlign: "center", lineHeight: 20, fontSize: 14, color: colors.textInverse, overflow: "hidden" },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkText: { ...typography.caption, flex: 1, color: colors.textSecondary, lineHeight: 18 },
  link: { color: colors.primary, textDecorationLine: "underline" },
  error: { ...typography.caption, color: colors.danger },
  login: { alignSelf: "center", paddingVertical: spacing.sm },
  loginText: { ...typography.caption, color: colors.textSecondary },
});
