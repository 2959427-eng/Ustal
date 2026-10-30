import { KeyboardAvoid } from "../../src/components/KeyboardAvoid";
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, ScrollView, Keyboard, Pressable, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ProfileItemsManager } from "../../src/components/ProfileItemsManager";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { checkAiAction } from "../../src/api/consents";
import { currentApiSession } from "../../src/api/client";
import { aiBlockedRoute } from "../../src/lib/ai-consent-flow";
import { getProfile, submitProfileInput, getProfileDraft, applyProfileDraft, discardProfileDraft, recognizedLabels } from "../../src/api/profile";
import { generateIdempotencyKey } from "../../src/lib/idempotency-key";
import { useFormDraft } from "../../src/lib/form-drafts";
import { PROFILE_INPUT_PENDING_KEY, type ProfileInputPending } from "../../src/lib/profile-draft";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 45000;

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
 * Пауза применения (экран 10, «...подтверждения удаления значимых
 * пунктов») остаётся — она про результат AI-extraction, а не про
 * транскрипцию, и относится к любому вводу: extraction создаёт ЧЕРНОВИК
 * (`phase="processing"` → поллинг GET /profile/draft), который показывается
 * пользователю С ДИФФОМ (что добавится/уберётся) ДО применения
 * (`phase="draft_review"`) — пользователь явно применяет
 * (POST /profile/draft/{id}/apply) или отклоняет (POST .../discard).
 * `GET /profile` (ниже) отдаёт только уже применённую версию.
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
 */
export default function ProfileScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Черновик переживает переход к окну согласия и обратно (экран пересоздаётся); очищается только после отправки.
  const [text, setText, clearText, , ownsForm] = useFormDraft("profile", () => "");
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // waiting — ждём результат extraction после отправки текста.
  const [waiting, setWaiting] = useState(false);
  // notice — понятное сообщение после apply / пустого результата.
  const [notice, setNotice] = useState<string | null>(null);

  // Поле ввода внизу длинного экрана (под сводкой профиля): при редактировании клавиатура его закрывала
  // (QA 2026-10-17, iPhone). Подводим поле к верху видимой области, когда оно в фокусе и клавиатура
  // открылась/сменила высоту; длинный текст прокручивается внутри поля (высота ограничена долей экрана),
  // поэтому строка с курсором остаётся видна на любых размерах экрана iOS и Android.
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const inputY = useRef(0);
  const inputFocused = useRef(false);
  const revealInput = () => {
    if (!inputFocused.current) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, inputY.current - spacing.md), animated: true }));
  };
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", revealInput);
    const frame = Keyboard.addListener("keyboardDidChangeFrame", revealInput);
    return () => { show.remove(); frame.remove(); };
  }, []);

  // UI-blocker #2 fix: экран больше НЕ зависит от «фазы». Сохранённый профиль
  // и форма ввода показываются всегда; ожидающий черновик — отдельный блок.
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });
  // Ошибка загрузки (сеть / 500) без данных — не «пустой профиль» (mobile QA 2026-10-14, M03).
  const loadFailed = isError && !data;

  const draftQuery = useQuery({
    queryKey: ["profileDraft"],
    queryFn: getProfileDraft,
    refetchInterval: waiting ? POLL_INTERVAL_MS : false,
  });
  const draft = draftQuery.data?.draft ? draftQuery.data : null;

  // Черновик появился — перестаём ждать.
  useEffect(() => {
    if (waiting && draft) setWaiting(false);
  }, [waiting, draft]);

  // Таймаут ожидания: extraction ничего не создал.
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      setWaiting(false);
      setNotice("AI не нашёл в тексте навыков или ресурсов. Опишите конкретнее, например: «умею красить стены, есть перфоратор».");
    }, POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  const onSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || submitLock.current || !ownsForm()) return; // обработчик прежней сессии ничего не отправляет
    submitLock.current = true;
    setSubmitError(null);
    setNotice(null);
    Keyboard.dismiss();
    setSubmitting(true);
    // Всё действие (проверка согласия и отправка) — от имени сессии, в которой нажата кнопка.
    const session = currentApiSession();
    const stale = () => session !== currentApiSession() || !ownsForm();
    try {
      // До первой ИИ-обработки — окно согласия; после решения возвращаемся сюда, текст сохраняется.
      const check = await checkAiAction(session);
      if (stale()) return;
      if (!check.ok) {
        const route = aiBlockedRoute(check, "profile");
        if (route) router.push(route); else setSubmitError(check.message);
        return;
      }
      const idempotencyKey = generateIdempotencyKey("profile-input");
      await submitProfileInput({ inputType: "text", text: trimmed }, idempotencyKey, session);
      if (stale()) return;
      clearText("");
      // 2026-09-30: сразу в «Мой профиль» — статус AI и «Проверить и применить» показываются там.
      queryClient.setQueryData<ProfileInputPending>(PROFILE_INPUT_PENDING_KEY, { at: Date.now(), prevDraftId: draft?.draft?.id ?? null });
      void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
      router.navigate("/(tabs)/account");
    } catch (err) {
      if (stale()) return;
      setSubmitError(err instanceof Error ? err.message : "Не удалось отправить. Попробуйте ещё раз.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const clearDraftCache = () => {
    queryClient.setQueryData(["profileDraft"], (prev: unknown) =>
      prev && typeof prev === "object" ? { ...(prev as object), draft: null } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
  };

  const onApplyDraft = async () => {
    if (!draft?.draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const applied = await applyProfileDraft(draft.draft.id);
      clearDraftCache();
      // Берём свежий профиль напрямую (а не через invalidate, который молча
      // оставляет старые данные при ошибке рефетча) и кладём в кэш.
      const fresh = await getProfile();
      queryClient.setQueryData(["profile"], fresh);
      Keyboard.dismiss();
      if (fresh.profile?.id !== applied.profileId) {
        setSubmitError("Изменения применены, но сервер вернул другую версию профиля. Обновите экран.");
      } else {
        setNotice("Сохранено");
        // Навыки применены — сразу возвращаем в личный кабинет (там свежий профиль уже в кэше).
        router.navigate("/(tabs)/account");
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось применить изменения.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDiscardDraft = async () => {
    if (!draft?.draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await discardProfileDraft(draft.draft.id);
      clearDraftCache();
      setNotice(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось отклонить изменения.");
    } finally {
      setSubmitting(false);
    }
  };

  const saved = recognizedLabels(data);
  const hasSaved = !!data?.profile && (saved.capabilities.length > 0 || saved.resources.length > 0 || !!data.profile.summary ||
    (data.restrictions?.length ?? 0) > 0 || (data.removed?.length ?? 0) > 0);
  const addedUnmapped = draft?.diff.addedUnmapped ?? [];
  const draftEmpty =
    !!draft &&
    draft.diff.addedCapabilities.length === 0 &&
    draft.diff.addedResources.length === 0 &&
    addedUnmapped.length === 0 &&
    draft.diff.removedCapabilities.length === 0 &&
    draft.diff.removedResources.length === 0;

  return (
    <KeyboardAvoid>
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + spacing.sm }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Pressable style={styles.back} onPress={() => router.navigate("/(tabs)/account")} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Навыки и ресурсы</Text>
      {notice && <Text style={notice === "Сохранено" ? styles.success : styles.hint}>{notice}</Text>}

      {isLoading && <ActivityIndicator color={colors.primary} />}

      {/* Сохранённые навыки и ресурсы — показываются всегда */}
      {!isLoading && hasSaved && data?.profile && (
        <View style={styles.summaryBox}>
          {!!data.profile.summary && <Text style={styles.summaryText}>{data.profile.summary}</Text>}
          {/* Пункты с прямыми действиями без AI (2026-10-17): «Убрать», «Снять ограничение», «Восстановить». */}
          <ProfileItemsManager profile={data} />
        </View>
      )}
      {!isLoading && loadFailed && (
        <View style={styles.processingBox}>
          <Text style={styles.processingText}>Не удалось загрузить сохранённые навыки и ресурсы. Проверьте соединение.</Text>
          <PrimaryButton label="Повторить" variant="secondary" loading={isFetching} onPress={() => { void refetch(); }} />
        </View>
      )}
      {!isLoading && !loadFailed && !hasSaved && (
        <Text style={styles.hint}>Пока нет сохранённых навыков и ресурсов. Добавьте их ниже.</Text>
      )}

      {/* Ожидание результата AI */}
      {waiting && !draft && (
        <View style={styles.processingBox}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.processingText}>AI обрабатывает вашу запись…</Text>
          <PrimaryButton
            label="Отмена"
            variant="secondary"
            onPress={() => {
              setWaiting(false);
            }}
          />
        </View>
      )}

      {/* Ожидающий черновик — отдельный блок */}
      {draft?.draft && draftEmpty && (
        <View style={styles.summaryBox}>
          <Text style={styles.reviewTitle}>AI не нашёл новых навыков или ресурсов</Text>
          <Text style={styles.hint}>
            Попробуйте описать конкретнее, что вы умеете делать или какие у вас есть инструменты, транспорт или оборудование.
          </Text>
        </View>
      )}
      {draft?.draft && !draftEmpty && (
        <View style={styles.reviewBox}>
          <Text style={styles.reviewTitle}>AI предлагает изменить профиль</Text>
          <Text style={styles.summaryText}>{draft.draft.summary}</Text>
          {(draft.diff.addedCapabilities.length > 0 || draft.diff.addedResources.length > 0 || addedUnmapped.length > 0) && (
            <View style={styles.diffSection}>
              <Text style={styles.diffLabel}>Добавится:</Text>
              {[...new Set([...draft.diff.addedCapabilities, ...draft.diff.addedResources, ...addedUnmapped])].map((label) => (
                <Text key={label} style={styles.diffAdded}>+ {label}</Text>
              ))}
            </View>
          )}
          {(draft.diff.removedCapabilities.length > 0 || draft.diff.removedResources.length > 0) && (
            <View style={styles.diffSection}>
              <Text style={styles.diffLabel}>Уберётся:</Text>
              {[...draft.diff.removedCapabilities, ...draft.diff.removedResources].map((label) => (
                <Text key={label} style={styles.diffRemoved}>− {label}</Text>
              ))}
            </View>
          )}
          {submitError && <Text style={styles.error}>{submitError}</Text>}
          <PrimaryButton label="Применить" onPress={onApplyDraft} loading={submitting} />
          <PrimaryButton label="Отклонить" variant="secondary" onPress={onDiscardDraft} disabled={submitting} />
        </View>
      )}

      {/* Форма добавления — всегда */}
      <TextInput
        style={[styles.textArea, { maxHeight: Math.max(160, Math.round(windowHeight * 0.25)) }]}
        multiline
        scrollEnabled
        value={text}
        onChangeText={setText}
        onLayout={(e) => { inputY.current = e.nativeEvent.layout.y; }}
        onFocus={() => { inputFocused.current = true; revealInput(); setTimeout(revealInput, 300); }}
        onBlur={() => { inputFocused.current = false; }}
        placeholder="Опишите себя текстом, какие у вас навыки, инструменты или транспорт"
        placeholderTextColor={colors.textSecondary}
      />
      {!draft && submitError && <Text style={styles.error}>{submitError}</Text>}
      <PrimaryButton
        label="Сохранить"
        onPress={onSubmit}
        loading={submitting && !draft}
        disabled={text.trim().length === 0 || waiting}
      />

      <PrimaryButton label="В мой профиль" variant="secondary" onPress={() => router.navigate("/(tabs)/account")} />
    </ScrollView>
    </KeyboardAvoid>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.surface },
  success: { ...typography.body, color: colors.success },
  container: { flexGrow: 1, backgroundColor: colors.surface, padding: spacing.lg, gap: spacing.md },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  title: { ...typography.title, fontSize: 28, lineHeight: 34, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger },
  hint: { ...typography.caption, color: colors.textSecondary },
  summaryBox: { backgroundColor: colors.background, borderRadius: radii.md, padding: spacing.md, gap: spacing.md },
  summaryText: { ...typography.body, color: colors.textPrimary },
  processingBox: { alignItems: "center", gap: spacing.xs, padding: spacing.md },
  processingText: { ...typography.body, color: colors.textSecondary },
  reviewBox: { backgroundColor: colors.background, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  reviewTitle: { ...typography.subtitle, color: colors.textPrimary },
  textArea: {
    ...typography.body,
    backgroundColor: colors.background,
    borderRadius: radii.lg,
    padding: spacing.md,
    minHeight: 120,
    color: colors.textPrimary,
    textAlignVertical: "top",
  },
  diffSection: { gap: 2 },
  diffLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  diffAdded: { ...typography.body, color: colors.success },
  diffRemoved: { ...typography.body, color: colors.danger },
});
