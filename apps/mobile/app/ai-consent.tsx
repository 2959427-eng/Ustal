import { useCallback, useRef, useState } from "react";
import { ScrollView, Text, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { aiConsentErrorMessage, decideAiConsent, getAiConsent, revokeAiConsentGrant } from "../src/api/consents";
import { currentApiSession } from "../src/api/client";
import { AI_CONSENT_STATUS_LABEL, type AiConsentState, type RevocableGrant } from "../src/lib/ai-consent-state";
import { afterAiConsentRoute, AI_CONSENT_GRANT_LABEL, AI_CONSENT_NOT_ENFORCED, AI_CONSENT_REFUSE_LABEL, AI_CONSENT_TEXT } from "../src/lib/ai-consent-flow";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { LegalLink } from "../src/components/LegalLinks";
import { colors, spacing, typography } from "../src/theme/tokens";

/**
 * «Как работает USTAL» — утверждённый текст (AI_CONSENT_TEXT) и решение пользователя.
 * Открывается перед первой ИИ-обработкой (заполнение профиля, заказ; next — куда вернуться), при новой версии
 * условий — перед следующей обработкой, и из «Аккаунт». После регистрации не показывается (2026-10-26).
 * Экран ничего не разрешает сам: передачу блокирует сервер (USTAL_AI_CONSENT_MODE=enforced), пока нет grant.
 */
export default function AiConsentScreen() {
  const { onboarding, next } = useLocalSearchParams<{ onboarding?: string; next?: string }>();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AiConsentState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const lock = useRef(false);

  const load = useCallback(async () => {
    setError("");
    // Состояние привязано к сессии, в которой получено (consents.ts); ответ прежней сессии не показывается.
    const session = currentApiSession();
    try {
      const next = await getAiConsent(session);
      if (session === currentApiSession()) setState(next);
    }
    catch { setState(null); setError("Не удалось загрузить состояние. Проверьте подключение и обновите экран."); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const leave = () => router.replace(afterAiConsentRoute({ onboarding: onboarding === "1", next }));

  const run = async (action: () => Promise<unknown>, thenLeave: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      await action();
      void queryClient.invalidateQueries({ queryKey: ["ai-consent"] });
      if (thenLeave) leave(); else await load();
    } catch (e) {
      await load();
      setError(aiConsentErrorMessage(e));
    } finally { lock.current = false; setBusy(false); }
  };
  const decide = (decision: "grant" | "revoke") => {
    if (state?.kind !== "required") return;
    void run(() => decideAiConsent(state, decision), onboarding === "1" || state.status !== "granted");
  };
  const revokeGrant = (grant: RevocableGrant) => void run(() => revokeAiConsentGrant(grant), false);

  const asking = state?.kind === "required" && state.status !== "granted";
  const revocable = state && state.kind !== "required" ? state.revocable ?? [] : [];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title} accessibilityRole="header">Как работает USTAL</Text>
      <Text style={styles.text}>{AI_CONSENT_TEXT[0]}</Text>
      <Text style={styles.text}>{AI_CONSENT_TEXT[1]}</Text>
      <LegalLink page="privacy" label={AI_CONSENT_TEXT[2]} />
      {asking ? <Text style={styles.text}>{AI_CONSENT_TEXT[3]}</Text> : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

      {state?.kind === "required" && (
        <View style={styles.gap}>
          <Text style={styles.caption}>Версия условий {state.policy.version} · {AI_CONSENT_STATUS_LABEL[state.status]}</Text>
          <Text style={styles.link} accessibilityRole="button" onPress={() => setShowTerms((v) => !v)}>
            {showTerms ? "Скрыть полные условия" : `Полные условия (версия ${state.policy.version})`}
          </Text>
          {showTerms ? <Text style={styles.text} selectable>{state.text}</Text> : null}
          {asking ? (
            <>
              <PrimaryButton label={AI_CONSENT_GRANT_LABEL} loading={busy} onPress={() => decide("grant")} />
              <PrimaryButton label={AI_CONSENT_REFUSE_LABEL} variant="secondary" disabled={busy} onPress={() => decide("revoke")} />
            </>
          ) : (
            <>
              <PrimaryButton label="Отозвать разрешение" variant="secondary" loading={busy} onPress={() => decide("revoke")} />
              <PrimaryButton label="Продолжить" disabled={busy} onPress={leave} />
            </>
          )}
        </View>
      )}

      {state && state.kind !== "required" && (
        <View style={styles.gap}>
          <Text style={styles.text}>{state.kind === "not_required" ? AI_CONSENT_NOT_ENFORCED
            : state.reason === "notice_mismatch"
              ? "Условия на сервере не совпадают с текстом в приложении. Разрешение не может быть дано, данные в OpenAI не передаются. Обновите приложение."
              : "Утверждённые условия пока недоступны, поэтому сервер не передаёт ваши данные в OpenAI. Функции ИИ временно не работают."}</Text>
          {revocable.map((g) => (
            <PrimaryButton key={g.purpose} label="Отозвать разрешение" variant="secondary" loading={busy} onPress={() => revokeGrant(g)} />
          ))}
          <PrimaryButton label="Продолжить" disabled={busy} onPress={leave} />
        </View>
      )}
      {!state && !error ? <Text style={styles.caption}>Загружаем…</Text> : null}
      {!state && error ? <PrimaryButton label="Обновить" onPress={() => void load()} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md, backgroundColor: colors.background, flexGrow: 1 },
  gap: { gap: spacing.md },
  title: { fontSize: 24, fontWeight: "700", color: colors.textPrimary },
  text: { ...typography.body, color: colors.textPrimary },
  caption: { ...typography.caption, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
  link: { ...typography.caption, color: colors.primary, textDecorationLine: "underline" },
});
