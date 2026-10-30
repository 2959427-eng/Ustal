import { useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@ustal/api-client";
import { applyProfileDraft, getProfileDraft, type ProfileDraftResponse } from "../api/profile";
import { isDraftEmpty, isResponseDraft, profileAiStatus, PROFILE_AI_GIVE_UP_MS, PROFILE_AI_WAIT_MS, PROFILE_INPUT_PENDING_KEY, type ProfileInputPending } from "../lib/profile-draft";
import { PrimaryButton } from "./PrimaryButton";
import { colors, spacing, typography } from "../theme/tokens";

/**
 * Блок внутри карточки «Навыки и ресурсы» в «Моём профиле»: статус AI после «Сохранить» и кнопка
 * «Изменить навыки и ресурсы». С 2026-10-06 результат AI применяется автоматически: «Сохранить»
 * — единственный шаг, отдельного «Проверить и применить» нет.
 */
/** Время отправки ещё не обработанного сообщения по данным сервера (переживает перезапуск приложения). */
function serverPendingAt(data: ProfileDraftResponse | undefined): number | null {
  if (!data?.processing || !data.processingSince) return null;
  const t = Date.parse(data.processingSince);
  return Number.isNaN(t) ? null : t;
}

/**
 * Интервал опроса черновика: пока ждём ответ на сохранённый текст — часто, затем реже; после срока
 * «AI не ответил» — раз в 30 с, только пока сервер сообщает, что сообщение ещё обрабатывается
 * (восстановление на сервере доводит его до результата). Иначе не опрашиваем.
 */
export function draftPollInterval(waitingSince: number | null, serverProcessing: boolean, now: number): number | false {
  if (waitingSince === null) return false;
  const elapsed = now - waitingSince;
  if (elapsed < PROFILE_AI_WAIT_MS) return 3000;
  if (elapsed < PROFILE_AI_GIVE_UP_MS) return 10_000;
  return serverProcessing ? 30_000 : false;
}

/** showEditButton=false — на пустом профиле: там главная кнопка своя, статус AI при этом остаётся. */
export function ProfileSkillsStatus({ showEditButton = true }: { showEditButton?: boolean } = {}) {
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

  // Обработка продолжается и после перезапуска приложения (M11): если локальной отметки нет, время
  // ожидания берётся из ответа сервера (processingSince), и черновик опрашивается, пока сервер сообщает,
  // что сохранённое сообщение ещё обрабатывается.
  const draftQuery = useQuery({
    queryKey: ["profileDraft"],
    queryFn: getProfileDraft,
    refetchInterval: (query) => draftPollInterval(pendingAt ?? serverPendingAt(query.state.data), query.state.data?.processing === true, Date.now()),
  });
  const waitingSince = pendingAt ?? serverPendingAt(draftQuery.data);
  useEffect(() => { setNow(Date.now()); }, [waitingSince]);
  const waiting = waitingSince !== null && now - waitingSince < PROFILE_AI_GIVE_UP_MS;

  // Старый черновик (был до «Сохранить») — не ответ на новый текст: ждём новый (M02).
  const draft = draftQuery.data?.draft && isResponseDraft(draftQuery.data.draft.id, pending) ? draftQuery.data : null;
  const draftEmpty = !!draft && "diff" in draft && isDraftEmpty(draft.diff);
  const status = profileAiStatus({ hasDraft: !!draft, draftEmpty, pendingAt: waitingSince, now });

  // Тикаем раз в секунду, пока ждём AI, — чтобы вовремя показать «обработка занимает дольше».
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  // Черновик — ответ на сохранённый текст: применяем сразу, один раз на черновик. Применяется только
  // отфильтрованный draft (M02): старый черновик не прекращает ожидание нового сообщения.
  const draftId = draft?.draft?.id ?? null;
  const attempted = useRef<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<"updated" | "nothing_found" | "error" | null>(null);
  useEffect(() => {
    if (!draftId || attempted.current === draftId) return;
    attempted.current = draftId;
    const empty = draftEmpty;
    setApplying(true);
    setResult(null);
    applyProfileDraft(draftId)
      .then(() => {
        setResult(empty ? "nothing_found" : "updated");
        queryClient.setQueryData(PROFILE_INPUT_PENDING_KEY, null);
      })
      .catch((err: unknown) => {
        // 409: черновик уже применён или устарел (есть более новый) — не ошибка пользователя:
        // перечитываем, более новый применится сам; продолжающуюся обработку покажет сервер.
        if (err instanceof ApiRequestError && err.status === 409) {
          queryClient.setQueryData(PROFILE_INPUT_PENDING_KEY, null);
          return;
        }
        // Иначе — явная ошибка с повтором того же сохранённого результата (M01); ожидание не сбрасываем.
        setResult("error");
      })
      .finally(() => {
        setApplying(false);
        void queryClient.invalidateQueries({ queryKey: ["profile"] });
        void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
      });
  }, [draftId, draftEmpty, queryClient, retryTick]);
  const retryApply = () => {
    attempted.current = null;
    setRetryTick((n) => n + 1);
  };
  // «Профиль обновлён» — короткое подтверждение, затем исчезает.
  useEffect(() => {
    if (result !== "updated") return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);
  // Новый текст отправлен — прежний итог больше не актуален.
  useEffect(() => { if (pendingAt !== null) setResult(null); }, [pendingAt]);

  return (
    <View style={styles.wrap}>
      {applying && (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>Обновляем навыки и ресурсы…</Text>
        </View>
      )}
      {!applying && result === "updated" && <Text style={styles.statusText}>Навыки и ресурсы обновлены.</Text>}
      {!applying && result === "error" && (
        <View style={styles.errorBox}>
          <Text style={styles.statusText}>Не удалось обновить навыки и ресурсы. Текст сохранён — можно повторить.</Text>
          <PrimaryButton label="Повторить" variant="secondary" onPress={retryApply} />
        </View>
      )}
      {/* Пустой diff ≠ «ничего не понято»: ограничения («не работаю после 22:00»), отказы и уточнения
          сохраняются в профиль и учитываются в подборе, но не являются новыми навыками или ресурсами. */}
      {!applying && result === "nothing_found" && (
        <Text style={styles.statusText}>
          Сохранено и учтено при подборе заказов. Новых навыков или ресурсов в этом тексте нет.
        </Text>
      )}
      {!applying && !draft && status === "processing" && (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>AI разбирает ваш текст…</Text>
        </View>
      )}
      {!applying && !draft && status === "slow" && (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>Обработка занимает дольше обычного…</Text>
        </View>
      )}
      {!applying && !draft && status === "no_response" && (
        <Text style={styles.statusText}>
          AI пока не ответил — ваш текст сохранён на сервере. Проверьте позже или попробуйте ещё раз.
        </Text>
      )}
      {showEditButton ? <PrimaryButton label="Изменить навыки и ресурсы" variant="secondary" onPress={() => router.push("/(tabs)/profile")} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginTop: spacing.xs },
  errorBox: { gap: spacing.xs },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusText: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
});
