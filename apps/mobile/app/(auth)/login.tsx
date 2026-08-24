import { useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

export default function LoginScreen() {
  const [phone, setPhone] = useState("+7");
  const [password, setPassword] = useState("");

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Вход</Text>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+7XXXXXXXXXX" />
      <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="Пароль" />
      <PrimaryButton label="Войти" onPress={() => { /* POST /auth/login — Фаза 2 */ }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.background, justifyContent: "center" },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  input: { ...typography.body, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.sm, color: colors.textPrimary },
});
