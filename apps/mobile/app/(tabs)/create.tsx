import { KeyboardAvoid } from "../../src/components/KeyboardAvoid";
import { AiConsentNotice } from "../../src/components/AiConsentNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Image, Pressable, Switch, ScrollView } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { PhotoPicker, type PickedPhoto } from "../../src/components/PhotoPicker";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { checkAiAction } from "../../src/api/consents";
import { currentApiSession } from "../../src/api/client";
import { aiBlockedRoute } from "../../src/lib/ai-consent-flow";
import { isCurrentDraftSession, readFormDraft, useFormDraft, useOnSessionChange, type OrderFormDraft } from "../../src/lib/form-drafts";
import { createOrder, getOrder, publishOrder, cancelOrder, retryOrder, type OrderDetail } from "../../src/api/orders";
import { generateIdempotencyKey } from "../../src/lib/idempotency-key";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 45000;

type Step = "compose" | "processing" | "failed" | "preview" | "publishing" | "published";

/**
 * Создание заказа — текст и фото (раздел 11/12 ТЗ). POST /orders запускает
 * асинхронный пайплайн заказа (extraction → модерация).
 *
 * Голосовой ввод и пауза «Проверка транскрипции» (экран 9/11 ТЗ) убраны из
 * этого экрана по просьбе пользователя — было неочевидно, что запись
 * работает как диктовка для AI, а не как голосовое сообщение. Бэкенд
 * по-прежнему поддерживает voice-заказы (см. src/api/orders.ts
 * createOrder/CreateOrderVoiceInput) — если решим вернуть, эндпоинты трогать
 * не придётся, а голосовой ввод для AI-профиля (app/(tabs)/profile.tsx)
 * этой правки не касается.
 *
 * Каждый шаг экрана — с явной кнопкой «✕» в углу (handleClose): раньше
 * отсюда некуда было выйти, если передумал (нижний таббар скрыт, а у
 * Tabs-навигатора нет «назад» на скрытый href:null экран). Если к моменту
 * закрытия заказ уже создан на сервере (submit уже прошёл) — он отменяется
 * (POST /orders/{id}/cancel), а не остаётся висеть в processing/на
 * модерации незаметно для пользователя.
 */
export default function CreateOrderScreen() {
  const queryClient = useQueryClient();
  const { prefillText, prefillSession } = useLocalSearchParams<{ prefillText?: string; prefillSession?: string }>();
  // Текст из параметров навигации — только если он передан в текущей сессии (проверка в момент чтения:
  // после A→B те же параметры A на сохранённом или пересозданном экране игнорируются).
  // Текст из композера той же сессии лежит и в черновике заказа — так он принимается и без id (старая сборка).
  const ownPrefill = () => (prefillText && (isCurrentDraftSession(prefillSession) || readFormDraft("order")?.text === prefillText) ? prefillText : "");
  const [step, setStep] = useState<Step>("compose");
  // Несохранённый заказ переживает переход к окну согласия и обратно; очищается после создания или сброса (✕).
  const [form, setForm, clearForm, discardForm, ownsForm] = useFormDraft("order", () => ({ text: ownPrefill(), priceText: "", acceptsPriceOffers: false, photos: [] }));
  const formRef = useRef(form);
  formRef.current = form;
  // Устаревший обработчик (смена сессии) не пишет ни в черновик, ни в formRef.
  const patchForm = (patch: Partial<OrderFormDraft>) => { const next = { ...formRef.current, ...patch }; if (setForm(next)) formRef.current = next; };
  const { text, photos, priceText, acceptsPriceOffers } = form;
  const setText = (value: string) => patchForm({ text: value });
  const setPhotos = (value: PickedPhoto[]) => patchForm({ photos: value });
  const setPriceText = (value: string) => patchForm({ priceText: value });
  const setAcceptsPriceOffers = (value: boolean) => patchForm({ acceptsPriceOffers: value });
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const sessionResetRef = useRef<() => void>(() => {});
  useOnSessionChange(useCallback(() => sessionResetRef.current(), []));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const orderIdRef = useRef<string | null>(null);
  const pollDeadlineRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // Вкладки expo-router держат экраны примонтированными между переходами
  // (initial useState() выше отработает только при первом монтировании) —
  // если с главной пришли новые параметры, а композер ещё пуст (ничего не
  // отправлено и не начато заново), подхватываем их и здесь.
  useEffect(() => {
    // Текст из композера записывается и в черновик — переживает окно согласия внутри той же сессии.
    const prefill = ownPrefill();
    if (step !== "compose" || !prefill || (text.trim().length > 0 && text !== prefill)) return;
    setText(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText, prefillSession]);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const pollOrder = async () => {
    const orderId = orderIdRef.current;
    if (!orderId) return;
    try {
      const detail = await getOrder(orderId);
      setOrder(detail);
      if (detail.status === "processing_failed") {
        stopPolling();
        setStep("failed");
        return;
      }
      if (detail.moderationStatus !== "pending") {
        stopPolling();
        setStep("preview");
        return;
      }
      if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
        setPollTimedOut(true);
        stopPolling();
      }
    } catch {
      // Сеть моргнула — пробуем на следующем тике, дедлайн всё равно остановит.
      if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
        setPollTimedOut(true);
        stopPolling();
      }
    }
  };

  const startExtractionPolling = () => {
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    setPollTimedOut(false);
    setStep("processing");
    void pollOrder();
    pollTimerRef.current = setInterval(pollOrder, POLL_INTERVAL_MS);
  };

  /** ИИ-обработка без согласия не запускается: сообщение и переход к заполнению профиля / окну согласия. */
  const blockAi = (check: Extract<Awaited<ReturnType<typeof checkAiAction>>, { ok: false }>) => {
    setSubmitError(check.message);
    const route = aiBlockedRoute(check, "other");
    if (route) router.push(route);
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || submitLock.current || !ownsForm()) return; // обработчик прежней сессии ничего не отправляет
    submitLock.current = true;
    setSubmitError(null);
    setSubmitting(true);
    // Всё действие — от имени сессии, в которой нажата кнопка; после смены сессии ни одного запроса.
    const session = currentApiSession();
    const stale = () => session !== currentApiSession() || !ownsForm();
    try {
      const check = await checkAiAction(session);
      if (stale()) return;
      if (!check.ok) { blockAi(check); return; }
      const priceMinor = priceText.trim() ? Math.round(Number(priceText.trim()) * 100) : undefined;
      const mediaIds = photos.map((p) => p.mediaId);
      const idempotencyKey = generateIdempotencyKey("order-create");
      const accepted = await createOrder({ inputType: "text", text: trimmed, priceMinor, acceptsPriceOffers, mediaIds }, idempotencyKey, session);
      if (stale()) return;
      orderIdRef.current = accepted.orderId;
      discardForm(); // заказ создан — черновик больше не нужен (на экране он остаётся до сброса)
      startExtractionPolling();
    } catch (err) {
      if (stale()) return;
      setSubmitError(err instanceof Error ? err.message : "Не удалось создать заказ. Попробуйте ещё раз.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const handlePublish = async () => {
    const orderId = orderIdRef.current;
    if (!orderId) return;
    setPublishError(null);
    setStep("publishing");
    try {
      await publishOrder(orderId);
      void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      setStep("published");
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Не удалось опубликовать. Попробуйте ещё раз.");
      setStep("preview");
    }
  };

  // Смена сессии на сохранённом экране: созданный заказ A, его опрос и шаг формы не переходят к B
  // (черновик формы сбрасывает useFormDraft).
  sessionResetRef.current = () => {
    stopPolling();
    orderIdRef.current = null;
    pollDeadlineRef.current = null;
    setOrder(null);
    setSubmitError(null);
    setPublishError(null);
    setPollTimedOut(false);
    setStep("compose");
  };

  const reset = () => {
    stopPolling();
    orderIdRef.current = null;
    pollDeadlineRef.current = null;
    setOrder(null);
    const empty = { text: "", priceText: "", acceptsPriceOffers: false, photos: [] };
    if (clearForm(empty)) formRef.current = empty;
    setSubmitError(null);
    setPublishError(null);
    setPollTimedOut(false);
    setStep("compose");
  };

  const handleClose = () => {
    const orderId = orderIdRef.current;
    if (orderId && step !== "published") {
      // Best-effort — не блокируем выход, если отмена не удалась на сервере.
      void cancelOrder(orderId).catch(() => {});
    }
    stopPolling();
    reset();
    router.navigate("/(tabs)/orders");
  };

  const CloseButton = (
    <View style={styles.topBar}>
      <Pressable onPress={handleClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Закрыть">
        <Text style={styles.closeIcon}>✕</Text>
      </Pressable>
    </View>
  );

  if (step === "compose") {
    return (
      <KeyboardAvoid>
      <ScrollView contentContainerStyle={[styles.container, { flex: 0, flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
        {CloseButton}
        <Text style={styles.title}>Что вам нужно?</Text>
        <AiConsentNotice />
        <TextInput
          style={styles.textArea}
          multiline
          value={text}
          onChangeText={setText}
          placeholder="Опишите, что нужно сделать — своими словами"
          placeholderTextColor={colors.textSecondary}
        />
        <Text style={styles.label}>Фотографии (необязательно)</Text>
        <PhotoPicker photos={photos} onChange={setPhotos} disabled={submitting} />
        <Text style={styles.label}>Цена, ₽ (необязательно)</Text>
        <TextInput
          style={styles.priceInput}
          value={priceText}
          onChangeText={setPriceText}
          keyboardType="numeric"
          placeholder="Например, 2000"
        />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Готов рассмотреть предложения с другой ценой</Text>
          <Switch value={acceptsPriceOffers} onValueChange={setAcceptsPriceOffers} disabled={submitting} />
        </View>
        {submitError && <Text style={styles.error}>{submitError}</Text>}
        <PrimaryButton label="Продолжить" onPress={handleSubmit} loading={submitting} disabled={text.trim().length === 0} />
      </ScrollView>
      </KeyboardAvoid>
    );
  }

  if (step === "failed") {
    return <View style={styles.container}>
      {CloseButton}
      <Text style={styles.title}>Не удалось обработать заказ.</Text>
      {submitError && <Text style={styles.hint}>{submitError}</Text>}
      <PrimaryButton label="Попробовать снова" loading={submitting} onPress={async () => {
        if (!orderIdRef.current || !ownsForm()) return;
        setSubmitting(true);
        setSubmitError(null);
        const session = currentApiSession();
        const orderId = orderIdRef.current;
        try {
          const check = await checkAiAction(session);
          if (session !== currentApiSession()) return;
          if (!check.ok) { blockAi(check); return; }
          await retryOrder(orderId, session);
          if (session !== currentApiSession()) return;
          startExtractionPolling();
        }
        catch { if (session === currentApiSession()) setSubmitError("Не удалось повторить обработку. Попробуйте ещё раз."); }
        finally { setSubmitting(false); }
      }} />
    </View>;
  }

  if (step === "processing") {
    return (
      <View style={styles.container}>
        {CloseButton}
        <Text style={styles.title}>Что вам нужно?</Text>
        <AiConsentNotice />
        <View style={styles.processingBox}>
          {!pollTimedOut && <ActivityIndicator color={colors.primary} />}
          <Text style={styles.processingText}>AI обрабатывает заказ…</Text>
          {pollTimedOut && (
            <>
              <Text style={styles.hint}>Обработка занимает больше времени, чем обычно.</Text>
              <PrimaryButton
                label="Проверить снова"
                variant="secondary"
                onPress={() => {
                  pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
                  setPollTimedOut(false);
                  void pollOrder();
                  pollTimerRef.current = setInterval(pollOrder, POLL_INTERVAL_MS);
                }}
              />
            </>
          )}
        </View>
      </View>
    );
  }

  if ((step === "preview" || step === "publishing") && order) {
    if (order.status === "moderation_hold") {
      return (
        <View style={styles.container}>
          {CloseButton}
          <Text style={styles.title}>Заказ отправлен на проверку</Text>
          <Text style={styles.body}>
            {order.moderationStatus === "reject"
              ? "Этот заказ нельзя опубликовать в текущем виде."
              : "Заказ требует ручной проверки модератором, прежде чем его можно будет опубликовать."}
          </Text>
          <PrimaryButton label="Создать другой заказ" onPress={reset} />
        </View>
      );
    }

    return (
      <View style={styles.container}>
        {CloseButton}
        <Text style={styles.title}>Проверьте заказ</Text>
        {order.moderationStatus === "allow_with_warning" && (
          <Text style={styles.warning}>AI отметил этот заказ как требующий внимания при публикации.</Text>
        )}
        <View style={styles.previewBox}>
          <Text style={styles.previewTitle}>{order.normalizedTitle}</Text>
          <Text style={styles.previewDescription}>{order.normalizedDescription}</Text>
          {order.priceMinor != null && (
            <Text style={styles.previewPrice}>{(order.priceMinor / 100).toLocaleString("ru-RU")} ₽</Text>
          )}
          {order.contextualChips.length > 0 && (
            <View style={styles.chipRow}>
              {order.contextualChips.map((chip) => (
                <View key={chip} style={styles.chip}>
                  <Text style={styles.chipText}>{chip}</Text>
                </View>
              ))}
            </View>
          )}
          {photos.length > 0 && (
            <View style={styles.photoRow}>
              {photos.map((p) => (
                <Image key={p.mediaId} source={{ uri: p.uri }} style={styles.photoThumb} />
              ))}
            </View>
          )}
        </View>
        {publishError && <Text style={styles.error}>{publishError}</Text>}
        <PrimaryButton label="Опубликовать" onPress={handlePublish} loading={step === "publishing"} />
        <PrimaryButton label="Отменить" variant="secondary" onPress={handleClose} disabled={step === "publishing"} />
      </View>
    );
  }

  if (step === "published") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Заказ опубликован</Text>
        <Text style={styles.body}>Как только появятся отклики, вы увидите их во вкладке «Отклики».</Text>
        <PrimaryButton
          label="К моим заказам"
          onPress={() => {
            reset();
            router.push("/(tabs)/orders");
          }}
        />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  topBar: { flexDirection: "row", justifyContent: "flex-end" },
  closeIcon: { fontSize: 20, color: colors.textSecondary, padding: 4 },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
  label: { ...typography.caption, color: colors.textSecondary },
  textArea: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    minHeight: 120,
    color: colors.textPrimary,
    textAlignVertical: "top",
  },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  switchLabel: { ...typography.body, color: colors.textPrimary, flex: 1 },
  priceInput: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  error: { ...typography.caption, color: colors.danger },
  warning: { ...typography.caption, color: colors.warning },
  hint: { ...typography.caption, color: colors.textSecondary },
  processingBox: { alignItems: "center", gap: spacing.xs, padding: spacing.md },
  processingText: { ...typography.body, color: colors.textSecondary },
  previewBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  previewTitle: { ...typography.subtitle, color: colors.textPrimary },
  previewDescription: { ...typography.body, color: colors.textSecondary },
  previewPrice: { ...typography.subtitle, color: colors.textPrimary, marginTop: spacing.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  chip: { backgroundColor: colors.surfaceAlt, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  chipText: { ...typography.caption, color: colors.textPrimary },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  photoThumb: { width: 56, height: 56, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt },
});
