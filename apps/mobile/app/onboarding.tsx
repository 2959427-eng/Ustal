import { View, Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { colors, spacing, typography } from "../src/theme/tokens";

export default function OnboardingScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>USTAL</Text>
      <Text style={styles.subtitle}>
        Расскажите, что вам нужно, или что вы умеете делать — остальное сделает AI.
      </Text>
      <View style={styles.actions}>
        <PrimaryButton label="Начать" onPress={() => router.push("/(auth)/register")} />
        <PrimaryButton
          label="У меня уже есть аккаунт"
          variant="secondary"
          onPress={() => router.push("/(auth)/login")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, justifyContent: "center", gap: spacing.md },
  title: { ...typography.title, fontSize: 32, color: colors.textPrimary, textAlign: "center" },
  subtitle: { ...typography.body, color: colors.textSecondary, textAlign: "center", marginBottom: spacing.xl },
  actions: { gap: spacing.sm },
});
