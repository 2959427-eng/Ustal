import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { getCities, type City } from "../../src/api/cities";
import { register } from "../../src/api/auth";
import { clearRegistrationDraft, getRegistrationDraft } from "../../src/state/registrationDraft";
import { ensurePushRegistered } from "../../src/notifications/push";

export default function SelectCityScreen() {
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
      await register({ ...draft, cityId });
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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loadingCities ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <FlatList
          data={cities}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              style={styles.item}
              disabled={submittingCityId !== null}
              onPress={() => onSelectCity(item.id)}
            >
              <Text style={styles.itemText}>{item.name}</Text>
              {submittingCityId === item.id ? <ActivityIndicator color={colors.primary} /> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, backgroundColor: colors.background },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  item: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    marginBottom: spacing.xs,
  },
  itemText: { ...typography.body, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
});
