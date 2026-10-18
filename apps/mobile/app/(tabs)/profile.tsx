import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { getProfile, submitProfileInput, getProfileDraft, applyProfileDraft } from "../../src/api/profile";
import { generateIdempotencyKey } from "../../src/lib/idempotency-key";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 45000;

type Phase = "idle" | "processing";

/**
 * «Навыки и ресурсы» — конструктор AI-профиля возможностей (раздел 7 ТЗ).
 * Открывается по ссылке «Изменить» с экрана «Личный кабинет»
 * (app/(tabs)/account.tsx).
 *
 * 2026-09-13 fix: раньше здесь ДУБЛИРОВАЛИСЬ ссылки на уведомления/настройки
 * и «Выйти» — они уже есть (и полнее: настройки/уведомления/заблокированные
 * + подтверждение выхода) на настоящем экране профиля, app/(tabs)/account.tsx.
 * Здесь их быть не должно — этот экран только про сам AI-профиль.
 *
 * 2026-09-13 fix (голос): голосовой ввод убран по просьбе пользователя — та
 * же причина, что и для создания заказа (app/(tabs)/create.tsx): было
 * неочевидно, что запись — это диктовка для AI, а не голосовое сообщение.
 * Вместе с этим убрана и пауза «Проверка транскрипции» (экран 9 —
 * `phase="transcribing"`/`"transcript_review"`, STT + правка распознанного
 * текста) — она была нужна ТОЛЬКО голосовому вводу, текстовый её никогда не
 * проходил (см. старый комментарий ниже, который это же и объяснял).
 * Бэкенд (`submitProfileInput({inputType: "voice", ...})`,
 * `GET /profile/inputs/{id}`, `editProfileTranscript`, `confirmProfileInput`)
 * не трогала — оставлен нетронутым на случай, если голос вернут на другой
 * экран.
 *
 * 2026-09-14 fix: пустое состояние (профиля ещё нет) переделано под
 * согласованный с пользователем макет — карточка с иконкой и одной ясной
 * причиной заполнить профиль («Так заказы находят вас точнее») вместо
 * абстрактной кнопки «Создать AI-профиль» без объяснения. Заполненное
 * состояние раньше показывало ТОЛЬКО `data.capabilities` одним общим рядом
 * чипов — `data.resources` (API их отдаёт, `src/api/profile.ts`) нигде не
 * отображались вообще. Теперь два подписанных раздела: «Что я умею»
 * (capabilities) и «Ресурсы» (resources).
 *
 * 2026-09-14 fix (поле ввода сразу на экране): раньше поле ввода было
 * скрыто за отдельной кнопкой («Заполнить профиль»/«Рассказать ещё»),
 * которая открывала композер — лишний шаг. Убрала `composerOpen`: текстовое
 * поле теперь всегда видно на экране сразу под карточкой/сводкой, кнопка
 * подписана «Сохранить» (было «Отправить AI» — по просьбе пользователя,
 * сама отправка на сервер и AI-обработка не изменились).
 *
 * 2026-09-14 fix (убрана карточка-объяснение): пользователь счёл два блока
 * (карточка «Так заказы находят вас точнее» + поле ввода) избыточными —
 * убрала карточку `promptCard` полностью для пустого состояния (профиля
 * ещё нет), её текст-объяснение перенесла в плейсхолдер самого поля ввода.
 * Сводка уже заполненного профиля (`summaryBox` с «Что я умею»/«Ресурсы»)
 * не тронута — просьба касалась только верхнего блока в пустом состоянии.
 *
 * 2026-09-14 fix (safe area + скролл): экран открывается через `router.push`
 * без собственного header'а поверх `(tabs)`, поэтому верх контента рисовался
 * под статус-баром/чёлкой — верхние строки (заголовок) обрезались на многих
 * устройствах. Тот же паттерн, что уже используется на
 * `(tabs)/index.tsx`/`(tabs)/orders.tsx`: `useSafeAreaInsets()`,
 * `paddingTop: insets.top + spacing.lg` сверху и
 * `paddingBottom: Math.max(insets.bottom, spacing.lg)` снизу (чтобы кнопка
 * «Сохранить» не упиралась в домашний индикатор/жестовую панель). Заодно
 * корневой `View` заменён на `ScrollView` (как в `account.tsx`/
 * `(auth)/register.tsx`) — на небольших экранах заполненный профиль (сводка
 * + чипы «Что я умею»/«Ресурсы» + поле ввода) мог не поместиться и обрезаться
 * снизу без возможности прокрутить.
 *
 * 2026-09-14 fix (порядок блоков): раньше сводка «Что я умею»/«Ресурсы»
 * рисовалась ДО поля ввода — по просьбе пользователя поменяла местами: поле
 * «Опишите себя текстом» + кнопка «Сохранить» остаются как были (первыми),
 * а сводка уже сохранённого профиля теперь показывается ПОСЛЕ кнопки
 * «Сохранить».
 *
 * 2026-09-14 fix (убран лишний экран подтверждения): после «Сохранить» AI
 * готовил черновик и показывал отдельный экран «AI предлагает изменить
 * профиль» с диффом и кнопками «Применить»/«Отклонить» — пользователь счёл
 * этот дополнительный шаг подтверждения лишним (он уже нажал «Сохранить»).
 * Убрала фазу `draft_review` целиком: как только черновик готов
 * (GET /profile/draft вернул `draft`), он применяется автоматически
 * (POST /profile/draft/{id}/apply) без дополнительного подтверждения, и
 * экран сразу возвращается к обычному виду с уже обновлённой сводкой.
 * `discardProfileDraft` (POST .../discard) больше здесь не вызывается —
 * ручного отклонения черновика в этом сценарии больше нет.
 *
 * 2026-09-14 fix (второе поле ввода убрано, было лишним): пробовала разделить
 * ввод на два текстовых поля («Навыки» / «Ресурсы») — пользователь уточнил,
 * что это было не то: нужно ОДНО поле ввода (как раньше), а разделение на
 * «что я умею» / «ресурсы» должно происходить в РЕЗУЛЬТАТЕ — AI сам достаёт
 * из одного свободного текста (например «есть яхта, умею копать») и
 * способности, и ресурсы, и раскладывает их по двум подписанным разделам
 * сводки ниже (`summaryBox`, см. фикс выше) — это уже так и работает,
 * второе поле дублировало то, что AI и так делает. Вернула единое поле
 * ввода, второе (`resourcesText`) убрала полностью.
 */
export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");

  const pollDeadlineRef = useRef<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });

  const draftQuery = useQuery({
    queryKey: ["profileDraft"],
    queryFn: getProfileDraft,
    enabled: phase === "processing",
    refetchInterval: phase === "processing" ? POLL_INTERVAL_MS : false,
  });

  const applyReadyDraft = async (draftId: string) => {
    setPollTimedOut(false);
    pollDeadlineRef.current = null;
    setSubmitError(null);
    try {
      await applyProfileDraft(draftId);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось сохранить изменения.");
    } finally {
      setPhase("idle");
    }
  };

  // Черновик после extraction готов — применяем сразу, без отдельного
  // подтверждения (см. JSDoc фикс от 2026-09-14 выше).
  useEffect(() => {
    if (phase !== "processing" || !draftQuery.data) return;
    if (draftQuery.data.draft) {
      void applyReadyDraft(draftQuery.data.draft.id);
    } else if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
      setPollTimedOut(true);
    }
  }, [draftQuery.data, phase]);

  const startDraftPolling = () => {
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    setPollTimedOut(false);
    setPhase("processing");
  };

  const onSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const idempotencyKey = generateIdempotencyKey("profile-input");
      await submitProfileInput({ inputType: "text", text: trimmed }, idempotencyKey);
      startDraftPolling();
      setText("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось отправить. Попробуйте ещё раз.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: Math.max(insets.bottom, spacing.lg) },
      ]}
    >
      <Text style={styles.title}>Навыки и ресурсы</Text>

      {isLoading && phase === "idle" && <ActivityIndicator color={colors.primary} />}

      {phase === "idle" && (
        <>
          <TextInput
            style={styles.textArea}
            multiline
            value={text}
            onChangeText={setText}
            placeholder="Опишите себя текстом, какие у вас навыки, инструменты или транспорт"
            placeholderTextColor={colors.textSecondary}
          />
          {submitError && <Text style={styles.error}>{submitError}</Text>}
          <PrimaryButton label="Сохранить" onPress={onSubmit} loading={submitting} disabled={text.trim().length === 0} />
        </>
      )}

      {phase === "idle" && !isLoading && data?.profile && (
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>{data.profile.summary}</Text>
          {data.capabilities.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Что я умею</Text>
              <View style={styles.chipRow}>
                {data.capabilities.map((cap) => (
                  <View key={cap.id} style={styles.chip}>
                    <Text style={styles.chipText}>{cap.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          {data.resources.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Ресурсы</Text>
              <View style={styles.chipRow}>
                {data.resources.map((res) => (
                  <View key={res.id} style={styles.chip}>
                    <Text style={styles.chipText}>{res.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      )}

      {phase === "processing" && (
        <View style={styles.processingBox}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.processingText}>AI обрабатывает вашу запись…</Text>
          {pollTimedOut && (
            <>
              <Text style={styles.hint}>Обработка занимает больше времени, чем обычно.</Text>
              <PrimaryButton label="Проверить снова" variant="secondary" onPress={() => void draftQuery.refetch()} />
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger },
  hint: { ...typography.caption, color: colors.textSecondary },
  summaryBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.md },
  summaryText: { ...typography.body, color: colors.textPrimary },
  section: { gap: spacing.xs },
  sectionLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { backgroundColor: colors.surfaceAlt, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  chipText: { ...typography.caption, color: colors.textPrimary },
  processingBox: { alignItems: "center", gap: spacing.xs, padding: spacing.md },
  processingText: { ...typography.body, color: colors.textSecondary },
  textArea: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    minHeight: 120,
    color: colors.textPrimary,
    textAlignVertical: "top",
  },
});
