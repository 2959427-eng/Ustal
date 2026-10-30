import { useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { deleteAccount, expireLocalSession } from "../src/api/auth";
import { createAccountDeletion } from "../src/lib/account-deletion";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/**
 * Удаление аккаунта (Apple 5.1.1(v), Google Play account deletion; 2026-10-19). Открывается из «Личный кабинет»
 * → «Удалить аккаунт». Двухшаговое подтверждение: кнопка → ввод пароля → «Удалить навсегда». Сессия очищается
 * только после ответа сервера (DELETE /me); при ошибке экран остаётся, текст понятный, действие не повторяется само.
 * Вёрстка — из WIP 2026-09-14 (тот же визуальный язык, что подтверждение «Выйти»).
 */
export default function DeleteAccountScreen() {
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = useMemo(() => createAccountDeletion({ remove: deleteAccount, expire: expireLocalSession }), []);

  const onDelete = async () => {
    setError(null);
    setSubmitting(true);
    const result = await flow.run(password);
    if ("ignored" in result) return;
    if (result.ok || result.sessionGone) {
      router.replace("/onboarding");
      return;
    }
    setError(result.message);
    setSubmitting(false);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12} disabled={submitting}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Удаление аккаунта</Text>
      <Text style={styles.warning}>
        Это действие необратимо. Вы не сможете войти в этот аккаунт. Ваш профиль, описание навыков и ресурсов,
        сообщения о себе, фото и голосовые записи будут удалены, номер телефона освободится для новой регистрации.
        Открытые заказы будут отменены, отклики отозваны, переговоры завершены — участники получат уведомление.
        Если по заказу уже идёт работа, сначала завершите её. Отзывы и завершённые заказы других пользователей
        сохранятся, но без ваших личных данных — с подписью «Удалённый пользователь».
      </Text>

      {!confirming && (
        <Pressable style={styles.deleteButton} onPress={() => setConfirming(true)}>
          <Text style={styles.deleteText}>Удалить аккаунт</Text>
        </Pressable>
      )}

      {confirming && (
        <View style={styles.confirmBox}>
          <Text style={styles.confirmText}>Подтвердите паролем — это действие нельзя отменить</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Пароль"
            autoFocus
            editable={!submitting}
            textContentType="password"
            autoComplete="password"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.confirmRow}>
            <Pressable
              style={styles.cancelButton}
              onPress={() => { setConfirming(false); setPassword(""); setError(null); }}
              disabled={submitting}
            >
              <Text style={styles.cancelText}>Отмена</Text>
            </Pressable>
            <Pressable style={styles.confirmButton} onPress={onDelete} disabled={submitting || password.length === 0}>
              {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.confirmButtonText}>Удалить навсегда</Text>}
            </Pressable>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  title: { ...typography.title, fontSize: 28, lineHeight: 34, color: colors.textPrimary },
  warning: { ...typography.body, color: colors.textSecondary, lineHeight: 21 },
  deleteButton: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.button,
    paddingVertical: 15,
    alignItems: "center",
  },
  deleteText: { ...typography.body, fontWeight: "600", color: colors.danger },
  confirmBox: { backgroundColor: "#FBF3F2", borderWidth: 1, borderColor: "#F3DEDC", borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  confirmText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  input: {
    ...typography.body,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  error: { ...typography.caption, color: colors.danger },
  confirmRow: { flexDirection: "row", gap: spacing.sm },
  cancelButton: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.button,
    paddingVertical: 11,
    alignItems: "center",
  },
  cancelText: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
  confirmButton: { flex: 1, backgroundColor: colors.danger, borderRadius: radii.button, paddingVertical: 11, alignItems: "center" },
  confirmButtonText: { ...typography.body, fontWeight: "600", color: colors.textInverse },
});
