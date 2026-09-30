import { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProfileDraft } from "../api/profile";
import { isDraftEmpty, isResponseDraft, profileAiStatus, PROFILE_AI_GIVE_UP_MS, PROFILE_AI_WAIT_MS, PROFILE_INPUT_PENDING_KEY, type ProfileInputPending } from "../lib/profile-draft";
import { PrimaryButton } from "./PrimaryButton";
import { colors, radii, spacing, typography } from "../theme/tokens";

/**
 * Блок внутри карточки «Навыки и ресурсы» в «Моём профиле» (2026-09-30): статус AI после «Сохранить»
 * и единственная кнопка «Изменить навыки и ресурсы». Навыки попадают в профиль только после явного
 * «Применить» на экране навыков — здесь только «Проверить и применить» (переход туда).
 */
export function ProfileSkillsStatus() {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  // Подписка на отметку «текст отправлен» (экран «Мой профиль» — вкладка, остаётся смонтированным).
  const { data: pending = null } = useQuery<ProfileInputPending | null>({
    queryKey: PROFILE_INPUT_PENDING_KEY,
    queryFn: () => queryClient.getQueryData<ProfileInputPending | null>(PROFILE_INPUT_PENDING_KEY) ?? null,
    enabled: false,
    initialData: null,
  });
  const pendingAt = pending?.at ?? null;
  useEffect(() => { setNow(Date.now()); }, [pendingAt]);
  const waiting = pendingAt !== null && now - pendingAt < PROFILE_AI_GIVE_UP_MS;
  const slowPhase = pendingAt !== null && now - pendingAt >= PROFILE_AI_WAIT_MS;

  const draftQuery = useQuery({ queryKey: ["profileDraft"], queryFn: getProfileDraft, refetchInterval: waiting ? (slowPhase ? 10_000 : 3000) : false });
  // Старый черновик (был до «Сохранить») — не ответ на новый текст: ждём новый.
  const draft = draftQuery.data?.draft && isResponseDraft(draftQuery.data.draft.id, pending) ? draftQuery.data : null;
  const draftEmpty = !!draft && isDraftEmpty(draft.diff);
  const status = profileAiStatus({ hasDraft: !!draft, draftEmpty, pendingAt, now });

  // Тикаем раз в секунду, пока ждём AI, — чтобы вовремя показать «ничего не нашёл».
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  // Черновик пришёл — ожидание закончено; навыки обновятся после «Применить».
  useEffect(() => {
    if (draft && pendingAt !== null) queryClient.setQueryData(PROFILE_INPUT_PENDING_KEY, null);
  }, [draft, pendingAt, queryClient]);

  return (
    <View style={styles.wrap}>
      {status === "processing" && (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>AI разбирает ваш текст…</Text>
        </View>
      )}
      {status === "review" && (
        <View style={styles.reviewBox}>
          <Text style={styles.reviewTitle}>AI нашёл изменения — проверьте и примените</Text>
          <PrimaryButton label="Проверить и применить" onPress={() => router.push("/(tabs)/profile")} />
        </View>
      )}
      {status === "slow" && (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>Обработка занимает дольше обычного…</Text>
        </View>
      )}
      {status === "no_response" && (
        <Text style={styles.statusText}>
          AI пока не ответил — ваш текст сохранён на сервере. Проверьте позже или попробуйте ещё раз.
        </Text>
      )}
      {status === "nothing_found" && (
        <Text style={styles.statusText}>
          AI не нашёл новых навыков или ресурсов. Опишите конкретнее, что умеете и какие есть инструменты или транспорт.
        </Text>
      )}
      <PrimaryButton label="Изменить навыки и ресурсы" variant="secondary" onPress={() => router.push("/(tabs)/profile")} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginTop: spacing.xs },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusText: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
  reviewBox: { backgroundColor: colors.primaryTintBg, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  reviewTitle: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
});
