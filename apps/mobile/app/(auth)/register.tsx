import { useState } from "react";
import { Text, TextInput, StyleSheet, ScrollView } from "react-native";
import { router } from "expo-router";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { setRegistrationDraft } from "../../src/state/registrationDraft";

const PHONE_PATTERN = /^\+7\d{10}$/;

/**
 * Регистрация: имя, телефон, пароль, город (см. select-city). Сам вызов
 * POST /auth/register происходит на следующем экране (select-city) — там
 * появляется cityId, обязательный по контракту (packages/validation).
 * Здесь — только клиентская предвалидация тем же форматом, что и на
 * бэкенде (см. ruPhoneSchema), чтобы не гонять пользователя туда-обратно
 * между экранами из-за ошибки, которую видно уже здесь.
 */
export default function RegisterScreen() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onContinue = () => {
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
    setError(null);
    setRegistrationDraft({ name: name.trim(), phone, password });
    router.push("/(auth)/select-city");
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
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

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <PrimaryButton label="Выбрать город и продолжить" onPress={onContinue} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.background, flexGrow: 1 },
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
  hint: { ...typography.caption, color: colors.warning, marginBottom: spacing.sm },
  error: { ...typography.caption, color: colors.danger, marginBottom: spacing.sm },
});
