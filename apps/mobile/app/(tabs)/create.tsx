import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Image, Pressable } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { PhotoPicker, type PickedPhoto } from "../../src/components/PhotoPicker";
import { PrimaryButton } from "../../src/components/PrimaryButton";
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
  const { prefillText } = useLocalSearchParams<{ prefillText?: string }>();
  const [step, setStep] = useState<Step>("compose");
  const [text, setText] = useState(prefillText ?? "");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [priceText, setPriceText] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
    if (step !== "compose" || text.trim().length > 0) return;
    if (prefillText) setText(prefillText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);

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

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const priceMinor = priceText.trim() ? Math.round(Number(priceText.trim()) * 100) : undefined;
      const mediaIds = photos.map((p) => p.mediaId);
      const idempotencyKey = generateIdempotencyKey("order-create");
      const accepted = await createOrder({ inputType: "text", text: trimmed, priceMinor, mediaIds }, idempotencyKey);
      orderIdRef.current = accepted.orderId;
      startExtractionPolling();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось создать заказ. Попробуйте ещё раз.");
    } finally {
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
      setStep("published");
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Не удалось опубликовать. Попробуйте ещё раз.");
      setStep("preview");
    }
  };

  const reset = () => {
    stopPolling();
    orderIdRef.current = null;
    pollDeadlineRef.current = null;
    setOrder(null);
    setText("");
    setPhotos([]);
    setPriceText("");
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
      <View style={styles.container}>
        {CloseButton}
        <Text style={styles.title}>Что вам нужно?</Text>
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
        {submitError && <Text style={styles.error}>{submitError}</Text>}
        <PrimaryButton label="Продолжить" onPress={handleSubmit} loading={submitting} disabled={text.trim().length === 0} />
      </View>
    );
  }

  if (step === "failed") {
    return <View style={styles.container}>
      {CloseButton}
      <Text style={styles.title}>Не удалось обработать заказ.</Text>
      {submitError && <Text style={styles.hint}>{submitError}</Text>}
      <PrimaryButton label="Попробовать снова" loading={submitting} onPress={async () => {
        if (!orderIdRef.current) return;
        setSubmitting(true);
        setSubmitError(null);
        try { await retryOrder(orderIdRef.current); startExtractionPolling(); }
        catch { setSubmitError("Не удалось повторить обработку. Попробуйте ещё раз."); }
        finally { setSubmitting(false); }
      }} />
    </View>;
  }

  if (step === "processing") {
    return (
      <View style={styles.container}>
        {CloseButton}
        <Text style={styles.title}>Что вам нужно?</Text>
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
