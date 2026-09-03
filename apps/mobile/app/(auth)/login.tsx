import { useState } from "react";
import { ActivityIndicator, Text, TextInput, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { login } from "../../src/api/auth";
import { ensurePushRegistered } from "../../src/notifications/push";

export default function LoginScreen() {
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await login(phone, password);
      router.replace("/(tabs)");
      void ensurePushRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Вход</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        placeholder="+7XXXXXXXXXX"
        autoCapitalize="none"
        editable={!submitting}
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="Пароль"
        editable={!submitting}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {submitting ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <PrimaryButton label="Войти" onPress={onSubmit} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.background, justifyContent: "center" },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  input: { ...typography.body, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.sm, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger },
});
