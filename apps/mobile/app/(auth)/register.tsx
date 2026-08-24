import { useState } from "react";
import { Text, TextInput, StyleSheet, ScrollView } from "react-native";
import { router } from "expo-router";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

/**
 * Регистрация: имя, телефон, пароль, город (см. select-city), согласия.
 * Перед отправкой номер показывается пользователю для визуальной проверки
 * (раздел 5 ТЗ — OTP в MVP нет). Реальный submit к POST /auth/register и
 * состояния loading/error — подключаются вместе с react-hook-form + Zod
 * в момент, когда экран выбора города появится в маршруте (Фаза 2).
 */
export default function RegisterScreen() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");

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
        placeholder="+7XXXXXXXXXX"
      />
      <Text style={styles.hint}>Проверьте номер — он не подтверждается кодом в этой версии приложения.</Text>

      <Text style={styles.label}>Пароль</Text>
      <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />

      <PrimaryButton
        label="Выбрать город и продолжить"
        onPress={() => router.push("/(auth)/select-city")}
      />
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
});
