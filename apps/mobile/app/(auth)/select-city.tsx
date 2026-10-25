import { getLegalDocuments, registrationDocumentsReady } from "../../src/api/legal";
import { LegalLinks } from "../../src/components/LegalLinks";
import { useEffect, useState } from "react";
import { Text, StyleSheet, View, Pressable } from "react-native";
import { router } from "expo-router";
import { colors, spacing, typography } from "../../src/theme/tokens";
import { getCities, type City } from "../../src/api/cities";
import { register } from "../../src/api/auth";
import { clearRegistrationDraft, getRegistrationDraft } from "../../src/state/registrationDraft";
import { ensurePushRegistered } from "../../src/notifications/push";

import { CityPicker } from "../../src/components/CityPicker";

export default function SelectCityScreen() {
  const [documentsReady, setDocumentsReady] = useState(false);
  useEffect(() => { void getLegalDocuments().then(d => setDocumentsReady(registrationDocumentsReady(d))).catch(() => setDocumentsReady(false)); }, []);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [pdnAccepted, setPdnAccepted] = useState(false);
  const [cities, setCities] = useState<City[]>([]);
  const [loadingCities, setLoadingCities] = useState(true);
  const [submittingCityId, setSubmittingCityId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCities()
      .then(setCities)
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить список городов"))
      .finally(() => setLoadingCities(false));
  }, []);

  const onSelectCity = async (cityId: string) => {
    if (!__DEV__ && !documentsReady) { setError("Документы ещё не опубликованы — регистрация временно недоступна"); return; }
    if (!ageConfirmed) { setError("Подтвердите, что вам исполнилось 18 лет"); return; }
    if (!rulesAccepted || !pdnAccepted) { setError("Подтвердите условия и обработку данных"); return; }
    const draft = getRegistrationDraft();
    if (!draft) {
      // Экран открыт напрямую, без прохождения формы регистрации — данных
      // для завершения регистрации нет, возвращаем на её начало.
      router.replace("/(auth)/register");
      return;
    }
    setError(null);
    setSubmittingCityId(cityId);
    try {
      await register({ ...draft, cityId, acceptedAge18: true, acceptedRules: true, acceptedPdn: true });
      clearRegistrationDraft();
      router.replace("/(tabs)");
      void ensurePushRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось завершить регистрацию");
    } finally {
      setSubmittingCityId(null);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Выберите город</Text>
      <LegalLinks />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: rulesAccepted }} disabled={!!submittingCityId} onPress={() => setRulesAccepted(v => !v)}><Text>{rulesAccepted ? "☑" : "☐"} Принимаю пользовательское соглашение</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: pdnAccepted }} disabled={!!submittingCityId} onPress={() => setPdnAccepted(v => !v)}><Text>{pdnAccepted ? "☑" : "☐"} Согласен с обработкой персональных данных</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: ageConfirmed }} disabled={!!submittingCityId} onPress={() => setAgeConfirmed(v => !v)}><Text>{ageConfirmed ? "☑" : "☐"} Мне исполнилось 18 лет</Text></Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <CityPicker cities={cities} loading={loadingCities} error={!loadingCities && cities.length === 0 && !!error} busyId={submittingCityId} onSelect={onSelectCity} onRetry={() => { setLoadingCities(true); setError(null); void getCities().then(setCities).catch(() => setError("Не удалось загрузить города")).finally(() => setLoadingCities(false)); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, backgroundColor: colors.background },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  error: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
});
