import { useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decideAiConsent, getAiConsent } from "../src/api/consents";
import { legalDocumentUrl } from "../src/api/legal";
import { AI_CONSENT_STATUS_LABEL } from "../src/lib/ai-consent";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { colors, spacing, typography } from "../src/theme/tokens";

/**
 * Согласие на обработку данных сторонним ИИ-сервисом (существующий механизм /me/consents). Текст — утверждённая
 * публикация с сервера, не из приложения. «Не согласен» и «Отозвать» записываются как отказ (revoke) этой версии:
 * сервер сразу перестаёт передавать данные в ИИ, ожидающая обработка ставится на паузу.
 */
export default function AiConsentScreen() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["ai-consent"], queryFn: getAiConsent });
  const [saving, setSaving] = useState<"grant" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = query.data;

  const decide = async (decision: "grant" | "revoke") => {
    if (state?.kind !== "required") return;
    setError(null);
    setSaving(decision);
    try {
      await decideAiConsent(state, decision);
      await queryClient.invalidateQueries({ queryKey: ["ai-consent"] });
      if (router.canGoBack()) router.back();
    } catch {
      // 409: версия текста или решение изменились на другом устройстве — показываем актуальное и просим решить заново.
      setError("Не удалось сохранить решение. Проверьте текст ещё раз и повторите.");
      await query.refetch();
    } finally {
      setSaving(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Обработка данных ИИ</Text>
      {query.isLoading ? <ActivityIndicator /> : null}
      {query.isError ? <Text style={styles.error}>Не удалось загрузить. Проверьте соединение.</Text> : null}
      {state?.kind === "not_required" ? <Text style={styles.text}>Отдельное согласие сейчас не требуется.</Text> : null}
      {state?.kind === "unavailable" ? (
        <Text style={styles.text}>Текст согласия ещё не опубликован. Данные в сторонний ИИ-сервис не передаются; составление профиля и обработка заказов временно недоступны.</Text>
      ) : null}
      {state?.kind === "required" ? (
        <View style={{ gap: spacing.md }}>
          <Text style={styles.status}>{AI_CONSENT_STATUS_LABEL[state.status]} · версия {state.policy.version}</Text>
          <Text style={styles.text}>{state.text}</Text>
          <Text style={styles.link} onPress={() => { void Linking.openURL(legalDocumentUrl("privacy")); }}>Политика обработки персональных данных</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {state.status === "granted" ? (
            <PrimaryButton label="Отозвать согласие" variant="secondary" loading={saving === "revoke"} disabled={saving !== null} onPress={() => { void decide("revoke"); }} />
          ) : (
            <>
              <PrimaryButton label="Согласен" loading={saving === "grant"} disabled={saving !== null} onPress={() => { void decide("grant"); }} />
              {state.status !== "refused" ? (
                <PrimaryButton label="Не согласен" variant="secondary" loading={saving === "revoke"} disabled={saving !== null} onPress={() => { void decide("revoke"); }} />
              ) : null}
            </>
          )}
          <Text style={styles.hint}>Без согласия профиль из сообщений не составляется, новые заказы не обрабатываются и подбор не выполняется. Решение можно изменить здесь в любой момент: «Аккаунт» → «Обработка данных ИИ».</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md, backgroundColor: colors.background, flexGrow: 1 },
  title: { ...typography.title, color: colors.textPrimary },
  status: { ...typography.caption, color: colors.textSecondary },
  text: { ...typography.body, color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary },
  link: { ...typography.body, color: colors.primary, textDecorationLine: "underline" },
  error: { ...typography.caption, color: colors.danger },
});
