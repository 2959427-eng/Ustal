import { View, Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import { AiInputField } from "../../src/components/AiInputField";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography } from "../../src/theme/tokens";
import { useState } from "react";

/**
 * Главная: две точки входа — "Что вам нужно?" (создать заказ) и
 * "Что вы умеете делать?" (AI-профиль). Раздел 6/9 ТЗ.
 */
export default function HomeScreen() {
  const [needText, setNeedText] = useState("");

  return (
    <View style={styles.container}>
      <Text style={styles.greeting}>Здравствуйте</Text>

      <Text style={styles.sectionTitle}>Что вам нужно?</Text>
      <AiInputField
        value={needText}
        onChangeText={setNeedText}
        placeholder="Например: нужно перевезти диван на новую квартиру"
        onStartRecording={() => {}}
      />
      <PrimaryButton label="Опубликовать заказ" onPress={() => router.push("/(tabs)/create")} />

      <Text style={[styles.sectionTitle, { marginTop: spacing.xl }]}>Что вы умеете делать?</Text>
      <PrimaryButton
        label="Рассказать о себе"
        variant="secondary"
        onPress={() => router.push("/(tabs)/profile")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.sm },
  greeting: { ...typography.title, color: colors.textPrimary },
  sectionTitle: { ...typography.subtitle, color: colors.textPrimary, marginBottom: spacing.xs },
});
