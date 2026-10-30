import { useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoid } from "../src/components/KeyboardAvoid";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { LegalLink } from "../src/components/LegalLinks";
import { sendSupportMessage, supportErrorMessage, SUPPORT_MAX_LENGTH, SUPPORT_MIN_LENGTH } from "../src/api/support";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/** «Написать в поддержку»: текст проблемы уходит письмом на почту поддержки (POST /support). */
export default function SupportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const ready = text.trim().length >= SUPPORT_MIN_LENGTH;

  const send = async () => {
    if (!ready || inFlight.current) return;
    inFlight.current = true; setSending(true); setError(null);
    try { await sendSupportMessage(text); setSent(true); }
    catch (e) { setError(supportErrorMessage(e)); }
    finally { inFlight.current = false; setSending(false); }
  };

  return (
    <KeyboardAvoid>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: insets.top + spacing.sm }]} keyboardShouldPersistTaps="handled">
        <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Назад">
          <Text style={styles.backText}>← Назад</Text>
        </Pressable>
        <Text style={styles.title}>Поддержка</Text>
        {sent ? (
          <View style={styles.gap}>
            <Text style={styles.text}>Обращение отправлено. Мы ответим по номеру телефона из вашего аккаунта.</Text>
            <PrimaryButton label="Готово" onPress={() => router.back()} />
          </View>
        ) : (
          <View style={styles.gap}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Опишите проблему"
              placeholderTextColor={colors.textTertiary}
              accessibilityLabel="Опишите проблему"
              multiline
              maxLength={SUPPORT_MAX_LENGTH}
              textAlignVertical="top"
              editable={!sending}
            />
            <Text style={styles.hint}>Вместе с текстом мы получим ваше имя и номер телефона, чтобы ответить.</Text>
            {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
            <PrimaryButton label="Отправить" onPress={() => void send()} loading={sending} disabled={!ready} />
          </View>
        )}
        {/* Документы для вошедшего пользователя — здесь, а не на экране профиля (Apple 5.1.1: политика доступна в приложении). */}
        <View style={styles.docs}>
          <LegalLink page="privacy" label="Конфиденциальность" />
          <LegalLink page="terms" label="Пользовательское соглашение" />
        </View>
      </ScrollView>
    </KeyboardAvoid>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: spacing.lg, backgroundColor: colors.background },
  back: { alignSelf: "flex-start", marginBottom: spacing.sm },
  backText: { ...typography.body, color: colors.primary },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  gap: { gap: spacing.sm },
  text: { ...typography.body, color: colors.textPrimary },
  input: { ...typography.body, minHeight: 160, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
  docs: { marginTop: "auto", paddingTop: spacing.xl, gap: spacing.sm },
});
