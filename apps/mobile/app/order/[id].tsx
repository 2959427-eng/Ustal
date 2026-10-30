import { getOrderView } from "../../src/api/order-view";
import { useMarkOrderNotificationsRead } from "../../src/notifications/badges";
import { KeyboardAvoid } from "../../src/components/KeyboardAvoid";
import { OrderHeaderBlock } from "../../src/components/OrderHeaderBlock";
import { useEffect, useRef, useState } from "react";
import { responseStatusLabel } from "../../src/lib/response-status";
import { View, Text, Image, StyleSheet, ScrollView, ActivityIndicator, Pressable, TextInput, Linking, Alert, RefreshControl } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@ustal/api-client";
import { getOrder, retryOrder, publishOrder, cancelOrder, setResponsesAcceptance } from "../../src/api/orders";
import { parsePriceInput, PRICE_INPUT_ERROR } from "../../src/lib/price-input";
import { canDeleteOrder } from "../../src/lib/order-delete";
import { getMediaUrl } from "../../src/api/media";
import type { AssignmentStatus, OrderDetail } from "../../src/api/orders";
import { getOrderCandidates, createResponse, withdrawResponse, updateResponse } from "../../src/api/responses";
import type { OrderCandidate } from "../../src/api/responses";
import { unlockContact, getOrderContact } from "../../src/api/contacts";
import type { OrderContact } from "../../src/api/contacts";
import {
  selectCandidate,
  startAssignment,
  cancelSelection,
  completeAssignment,
  markAssignmentNotCompleted,
  reportAssignmentCompleted,
  reportAssignmentIssue,
} from "../../src/api/assignments";
import { RatingCard } from "../../src/components/RatingCard";
import { getMyResponse, myKeys } from "../../src/api/my";
import type { MyResponseItem } from "../../src/api/my";
import { ReportAndBlockRow } from "../../src/components/ReportAndBlockRow";
import { getOrderAuthor } from "../../src/api/users";
import { AuthorAvatar } from "../../src/components/AuthorAvatar";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { submitProfileInput } from "../../src/api/profile";
import { checkAiAction } from "../../src/api/consents";
import { currentApiSession } from "../../src/api/client";
import { aiBlockedRoute } from "../../src/lib/ai-consent-flow";
import { generateIdempotencyKey } from "../../src/lib/idempotency-key";
import { ReportModal } from "../../src/components/ReportModal";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const ASSIGNMENT_LABELS: Record<AssignmentStatus, string> = {
  selected: "Идут переговоры",
  in_progress: "В работе",
  completed: "Выполнено",
  not_completed: "Не выполнено",
  cancelled: "Отменено",
};

function formatPrice(priceMinor: number | null | undefined): string {
  if (priceMinor == null) return "Цена по договорённости";
  return `${Math.round(priceMinor / 100).toLocaleString("ru-RU")} ₽`;
}

/**
 * Единый экран заказа (docs/screens.md #16, 17, 20-25) — без отдельной
 * роли заказчика/исполнителя (architecture.md §2): один и тот же route
 * рендерит два принципиально разных вида в зависимости от того, кто
 * смотрит.
 *
 * Автор: GET /orders/{id} успевает (200) → полная карточка + кандидаты
 * (#20) + раскрытие контактов (#21) + выбор/закрытие (#22/#23) + отметка
 * результата (#24) + отзыв (#25).
 *
 * Не-автор (кандидат/исполнитель): GET /orders/{id} отдаёт 404 (сервер
 * скрывает чужие заказы, не 403 — см. apps/api/src/routes/orders.ts) — это
 * штатный, а не ошибочный путь, поэтому экран переключается на вид
 * кандидата: карточка заказа загружается по orderId из авторизованного API вместо параметров ленты
 * (#16), а собственный отклик (или его отсутствие) — из GET /my/responses
 * (тот же список, что и на вкладке «Отклики»). Форма отклика (#17),
 * раскрытие контакта автора после выбора (#21) и отзыв (#25) — тоже здесь.
 *
 * Жалоба и блокировка (разделы 28/29 ТЗ) — контекстные действия, не
 * отдельный экран: «Пожаловаться на заказ» у вида кандидата,
 * «Пожаловаться»/«Заблокировать» у каждого кандидата (вид автора) и у
 * автора заказа (вид кандидата).
 */
export default function OrderDetailScreen() {
  const { id, matchType } = useLocalSearchParams<{ id: string; matchType?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useMarkOrderNotificationsRead(id);

  const orderQuery = useQuery({
    queryKey: ["order", id],
    queryFn: () => getOrder(id),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "processing" && query.state.data.moderationStatus === "pending" ? 3000 : false,
  });

  const isNotAuthor = orderQuery.isError && orderQuery.error instanceof ApiRequestError && orderQuery.error.status === 404;
  const isOtherError = orderQuery.isError && !isNotAuthor;

  // Обновление открытого экрана жестом (F05): заказ, кандидаты, отчёты исполнителя, свой отклик, оценка.
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refreshScreen = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["order", id] }),
        queryClient.invalidateQueries({ queryKey: ["order-candidates", id] }),
        queryClient.invalidateQueries({ queryKey: ["order-view", id] }),
        queryClient.invalidateQueries({ queryKey: ["order-rating", id] }),
        queryClient.invalidateQueries({ queryKey: ["my-responses"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <KeyboardAvoid>
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refreshScreen(); }} />}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>

      <RatingCard orderId={id} />

      {orderQuery.isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isOtherError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить заказ.</Text>
          <Pressable onPress={() => orderQuery.refetch()}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {orderQuery.data && <AuthorView orderId={id} order={orderQuery.data} />}

      {isNotAuthor && <AuthorHeader orderId={id} />}

      {isNotAuthor && <CandidateView key={id} orderId={id} simpleTask={matchType === "opportunity"} />}

    </ScrollView>
    </KeyboardAvoid>
  );
}

/** Аватарка и имя заказчика; по нажатию — его профиль. */
function AuthorHeader({ orderId }: { orderId: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["order-author", orderId], queryFn: () => getOrderAuthor(orderId), retry: false });
  if (!q.data) return null;
  const a = q.data;
  return (
    <Pressable
      style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
      onPress={() => router.push({ pathname: "/user/[id]", params: { id: a.id, orderId } })}
    >
      <AuthorAvatar name={a.name} avatarMediaId={a.avatarMediaId} size={44} />
      <View>
        <Text style={{ fontWeight: "600", fontSize: 16, color: colors.textPrimary }}>{a.name}</Text>
        <Text style={{ fontSize: 13, color: colors.textSecondary }}>Заказчик · посмотреть профиль</Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Автор заказа
// ---------------------------------------------------------------------------

function AuthorView({ orderId, order }: { orderId: string; order: OrderDetail }) {
  const queryClient = useQueryClient();
  // ИИ-действия экрана — только от имени сессии, в которой экран открыт.
  const mountSession = useRef(currentApiSession()).current;
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // Синхронный guard публикации / повторной обработки / удаления: два нажатия до следующего render
  // не отправляют два запроса (F02). Освобождается после ответа сервера, в том числе после ошибки.
  const authorInFlight = useRef(false);
  const guarded = async (run: () => Promise<void>) => {
    if (authorInFlight.current) return;
    authorInFlight.current = true;
    try { await run(); } finally { authorInFlight.current = false; }
  };

  const candidatesQuery = useQuery({
    queryKey: ["order-candidates", orderId],
    queryFn: () => getOrderCandidates(orderId),
    enabled: HAS_CANDIDATES.includes(order.status),
    // Отчёт исполнителя (выполнено / проблема) приходит с другого устройства: пока идут переговоры или
    // работа, открытая карточка сама подтягивает актуальное состояние (F05).
    refetchInterval: LIVE_ASSIGNMENT_STATUSES.includes(order.status) ? CANDIDATES_POLL_MS : false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order-candidates", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["order-view", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["order-rating", orderId] });
  };

  // «Достаточно откликов» / «Снова принимать отклики» (2026-10-15): тот же синхронный guard, ошибка видна на экране.
  const [acceptanceBusy, setAcceptanceBusy] = useState(false);
  const toggleAcceptance = (action: "close" | "reopen") => guarded(async () => {
    setCloseError(null);
    setAcceptanceBusy(true);
    try {
      await setResponsesAcceptance(orderId, action);
      invalidate();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Не удалось изменить приём откликов.");
    } finally {
      setAcceptanceBusy(false);
    }
  });

  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const handleDelete = () => {
    Alert.alert("Удалить заказ?", "Заказ пропадёт из ленты исполнителей и из вашего списка.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: () => guarded(async () => {
          setCloseError(null);
          setDeleting(true);
          try {
            await cancelOrder(orderId);
            // Успех — только после ответа сервера: тогда обновляем список и уходим с экрана.
            void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
            router.back();
          } catch (err) {
            // Заказ остаётся на экране, ошибка видна при любом статусе, кнопка снова доступна (F01).
            setCloseError(err instanceof Error ? err.message : "Не удалось удалить заказ.");
            setDeleting(false);
          }
        }),
      },
    ]);
  };

  return (
    <View style={styles.gap}>
      <OrderHeaderBlock title={order.normalizedTitle} description={order.normalizedDescription} photoMediaIds={order.photoMediaIds} />
      <View style={styles.metaRow}>
        <Text style={styles.price}>{formatPrice(order.priceMinor)}</Text>
        <StatusBadge label={ORDER_STATUS_LABELS[order.status]} />
      </View>

      {order.status === "processing" && (
        order.moderationStatus === "pending" ? <Text style={styles.hint}>Заказ обрабатывается AI…</Text> :
        (order.moderationStatus === "allow" || order.moderationStatus === "allow_with_warning") &&
        <PrimaryButton label="Опубликовать" loading={closing} onPress={() => guarded(async () => {
          setClosing(true); setCloseError(null);
          try { await publishOrder(orderId); invalidate(); }
          catch { setCloseError("Не удалось опубликовать заказ."); }
          finally { setClosing(false); }
        })} />
      )}
      {order.status === "processing_failed" && <PrimaryButton label="Повторить обработку" loading={closing} onPress={() => guarded(async () => {
        setClosing(true); setCloseError(null);
        const session = mountSession;
        try {
          const check = await checkAiAction(session);
          if (session !== currentApiSession()) return;
          if (!check.ok) { setCloseError(check.message); const route = aiBlockedRoute(check, "other"); if (route) router.push(route); return; }
          await retryOrder(orderId, session);
          if (session !== currentApiSession()) return;
          invalidate();
        }
        catch { if (session === currentApiSession()) setCloseError("Не удалось повторить обработку."); }
        finally { setClosing(false); }
      })} />}
      {(order.status === "processing_failed" || order.status === "processing") && closeError &&
        <Text style={styles.error}>{closeError}</Text>}
      {order.status === "moderation_hold" && (
        <Text style={styles.hint}>
          {order.moderationStatus === "reject"
            ? "Заказ отклонён модерацией."
            : "Заказ на ручной проверке модератором."}
        </Text>
      )}

      {/*
       * 2026-09-14 fix: «старый заказ появился без фото» — этот экран
       * (единственное место, где автор видит уже созданный заказ повторно)
       * вообще не рендерил order.photoMediaIds. Фото были видны только на
       * шаге "preview" в create.tsx — но там источник картинок не сервер, а
       * ЛОКАЛЬНОЕ состояние photos (uri из пикера), которое живо только
       * пока не закрыт экран создания. Как только заказ открывали заново
       * (из списка "Мои заказы" или после перезапуска приложения) — фото
       * пропадали не потому, что не загрузились, а потому что их никто не
       * рисовал. GET /orders/{id} (apps/api/src/routes/orders.ts) уже
       * отдаёт photoMediaIds — просто рендерим их через GET /media/{id}.
       */}

      {HAS_CANDIDATES.includes(order.status) && (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>
            {candidatesQuery.data ? `Кандидаты (${candidatesQuery.data.items.filter((c) => c.status === "active").length})` : "Кандидаты"}
          </Text>

          {candidatesQuery.isLoading && <ActivityIndicator color={colors.primary} />}
          {candidatesQuery.isError && (
            <View style={styles.errorBox}>
              <Text style={styles.error}>Не удалось загрузить отклики.</Text>
              <Pressable onPress={() => candidatesQuery.refetch()}>
                <Text style={styles.retry}>Повторить</Text>
              </Pressable>
            </View>
          )}
          {candidatesQuery.data && candidatesQuery.data.items.length === 0 && (
            <Text style={styles.hint}>Пока никто не откликнулся.</Text>
          )}
          {candidatesQuery.data?.items.map((c) => (
            <CandidateRow key={c.id} orderId={orderId} orderStatus={order.status} candidate={c} onChanged={invalidate} />
          ))}
        </>
      )}

      {ACCEPTS_RESPONSES.includes(order.status) && order.responsesClosed !== undefined && (
        <>
          <Text style={styles.hint}>
            {order.responsesClosed
              ? "Приём новых откликов остановлен. Уже откликнувшиеся остаются в списке."
              : order.acceptingResponses === false
                ? `Набрано максимальное число откликов (${order.responseLimit ?? 150}).`
                : `Откликов: ${order.activeResponsesCount ?? 0} из ${order.responseLimit ?? 150}. Заказ показывается новым исполнителям, пока откликов мало.`}
          </Text>
          <PrimaryButton
            label={order.responsesClosed ? "Снова принимать отклики" : "Достаточно откликов"}
            variant="secondary"
            loading={acceptanceBusy}
            onPress={() => toggleAcceptance(order.responsesClosed ? "reopen" : "close")}
          />
        </>
      )}

      {canDeleteOrder(order.status) && (
        <PrimaryButton label="Удалить заказ" variant="secondary" onPress={handleDelete} loading={deleting} />
      )}
      {order.status !== "processing" && order.status !== "processing_failed" && closeError && (
        <Text style={styles.error}>{closeError}</Text>
      )}
    </View>
  );
}

/**
 * «Простая задача — опыт не нужен» (2026-10-15): заказ показан не по навыкам, а потому что не требует подготовки.
 * «Не показывать такие задачи» — обычное сообщение профиля с отказом: дальше работает существующий путь
 * (профиль → ограничение → новый подбор), без отдельной сущности.
 */
function SimpleTaskNotice({ title }: { title: string | null }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [blocked, setBlocked] = useState<string | null>(null);
  const router = useRouter();
  const mountSession = useRef(currentApiSession()).current;
  const sending = useRef(false);
  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setState("sending");
    setBlocked(null);
    const session = mountSession;
    try {
      const check = await checkAiAction(session);
      if (session !== currentApiSession()) return;
      if (!check.ok) {
        setState("idle"); setBlocked(check.message);
        const route = aiBlockedRoute(check, "other");
        if (route) router.push(route);
        return;
      }
      await submitProfileInput({ inputType: "text", text: `Не беру такие заказы: «${title ?? "эта задача"}»` }, generateIdempotencyKey("profile-input"), session);
      if (session !== currentApiSession()) return;
      setState("sent");
    } catch {
      if (session === currentApiSession()) setState("error");
    } finally {
      sending.current = false;
    }
  };
  return (
    <View style={styles.gap}>
      <Text style={styles.hint}>Простая задача — опыт не нужен. Показана, потому что для неё не требуется подготовка.</Text>
      {state === "sent"
        ? <Text style={styles.hint}>Учтём: такие задачи больше не будут показываться. Это видно в разделе «Ограничения» профиля.</Text>
        : <PrimaryButton label="Не показывать такие задачи" variant="secondary" loading={state === "sending"}
            onPress={() => Alert.alert("Не показывать такие задачи?", "В профиль добавится ограничение — его можно убрать позже.", [
              { text: "Отмена", style: "cancel" },
              { text: "Не показывать", onPress: () => { void send(); } },
            ])} />}
      {state === "error" && <Text style={styles.error}>Не удалось сохранить. Попробуйте ещё раз.</Text>}
      {blocked && <Text style={styles.error}>{blocked}</Text>}
    </View>
  );
}

/** Уровень соответствия откликнувшегося (2026-10-15). */
const FIT_LEVEL_LABELS: Record<"exact" | "probable" | "opportunity", string> = {
  exact: "Подходит по навыкам",
  probable: "Подходит по опыту",
  opportunity: "Простая задача — без подтверждённого опыта",
};
/** Статусы заказа, в которых принимаются отклики (и можно остановить/возобновить приём). */
const ACCEPTS_RESPONSES = ["published", "negotiating"];
/** Статусы заказа, при которых автору показываются кандидаты. */
const LIVE_ASSIGNMENT_STATUSES = ["negotiating", "in_progress"];
const CANDIDATES_POLL_MS = 15_000;
const HAS_CANDIDATES = ["published", "negotiating", "in_progress", "completed", "not_completed", "closed"];

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  processing: "Обрабатывается",
  processing_failed: "Ошибка обработки",
  moderation_hold: "На проверке",
  published: "Опубликован",
  negotiating: "Идут переговоры",
  in_progress: "В работе",
  completed: "Выполнен",
  not_completed: "Не выполнен",
  closed: "Закрыт",
  expired: "Истёк",
  cancelled: "Отменён",
  rejected: "Отклонён",
};

function CandidateRow({ orderId, orderStatus, candidate, onChanged }: { orderId: string; orderStatus: string; candidate: OrderCandidate; onChanged: () => void }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [contact, setContact] = useState<OrderContact | null>(null);
  const router = useRouter();

  // Контакт подгружается сам, как только раскрыт (после начала переговоров с кандидатом): кнопки «Показать» нет.
  useEffect(() => {
    if (!candidate.isContactUnlocked) return;
    let cancelled = false;
    getOrderContact(orderId, candidate.executorId)
      .then((c) => {
        if (!cancelled) setContact(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orderId, candidate.executorId, candidate.isContactUnlocked]);

  const run = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRowError(null);
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Не удалось выполнить действие.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // Отдельной кнопки «Раскрыть контакт» нет: API требует раскрытый контакт перед
  // созданием назначения, поэтому раскрываем его автоматически в том же нажатии
  // «Начать переговоры». Это НЕ финальный выбор исполнителя: назначение сразу
  // получает статус "selected" (идут переговоры) и может существовать одновременно
  // у нескольких кандидатов — единственного исполнителя фиксирует только отдельное
  // действие «Договорились» (handleStart ниже, POST .../start).
  const handleStartNegotiation = () =>
    run(async () => {
      if (!candidate.isContactUnlocked) await unlockContact(orderId, candidate.id);
      await selectCandidate(orderId, candidate.id);
    });
  const handleCancelNegotiation = () => {
    if (!candidate.assignmentId) return;
    Alert.alert("Прекратить переговоры?", "Контакт закроется — сможете снова начать переговоры с этим или другим кандидатом.", [
      { text: "Нет", style: "cancel" },
      { text: "Прекратить переговоры", style: "destructive", onPress: () => run(() => cancelSelection(orderId, candidate.assignmentId!)) },
    ]);
  };
  const handleStart = () => {
    if (!candidate.assignmentId) return;
    return run(() => startAssignment(orderId, candidate.assignmentId!));
  };
  const handleComplete = () => {
    if (!candidate.assignmentId) return;
    return run(() => completeAssignment(orderId, candidate.assignmentId!));
  };
  const handleNotCompleted = () => {
    if (!candidate.assignmentId) return;
    Alert.alert("Отметить как невыполненный?", undefined, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Отметить",
        style: "destructive",
        onPress: () => run(() => markAssignmentNotCompleted(orderId, candidate.assignmentId!)),
      },
    ]);
  };

  return (
    <View style={styles.candidateCard}>
      <View style={styles.metaRow}>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}
          onPress={() => router.push({ pathname: "/user/[id]", params: { id: candidate.executorId, orderId } })}
        >
          <AuthorAvatar name={candidate.executorName ?? "Исполнитель"} avatarMediaId={candidate.executorAvatarMediaId ?? null} size={44} />
          <Text style={styles.candidateName}>{candidate.executorName ?? "Исполнитель"}</Text>
        </Pressable>
        {candidate.assignmentStatus && <StatusBadge label={ASSIGNMENT_LABELS[candidate.assignmentStatus]} />}
      </View>
      {candidate.offeredPriceMinor != null && <Text style={styles.body}>Предложил: {formatPrice(candidate.offeredPriceMinor)}</Text>}
      {candidate.fitLevel && <Text style={styles.hint}>{FIT_LEVEL_LABELS[candidate.fitLevel]}</Text>}
      {candidate.comment && <Text style={styles.body}>{candidate.comment}</Text>}
      {candidate.status === "withdrawn" && <Text style={styles.hint}>Отклик отозван</Text>}
      {candidate.status === "not_selected" && <Text style={styles.hint}>{responseStatusLabel(candidate.status, orderStatus, candidate.assignmentStatus)}</Text>}

      {rowError && <Text style={styles.error}>{rowError}</Text>}

      {/*
       * Security-этап «исполнитель не должен зависать в работе»
       * (2026-09-22): исполнитель может сам отметить "работа выполнена" или
       * "не получилось" (пока заказ in_progress) — заказчику здесь только
       * показывается эта отметка рядом с его собственными кнопками
       * «Выполнено»/«Не выполнено» ниже, сама отметка ничего не завершает.
       */}
      {candidate.assignmentStatus === "in_progress" && candidate.executorReport === "completed" && (
        <Text style={styles.reportHintSuccess}>Исполнитель отметил: работа выполнена. Подтвердите результат ниже.</Text>
      )}
      {candidate.assignmentStatus === "in_progress" && candidate.executorReport === "issue" && (
        <Text style={styles.reportHintIssue}>Исполнитель сообщил, что не может выполнить заказ. Примите решение ниже.</Text>
      )}

      {candidate.status === "active" && !candidate.assignmentId && ["published", "negotiating"].includes(orderStatus) && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Начать переговоры" onPress={handleStartNegotiation} loading={busy} />
        </View>
      )}

      {candidate.isContactUnlocked && contact && <ContactActions contact={contact} />}

      {candidate.assignmentStatus === "selected" && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Договорились — начать выполнение" onPress={handleStart} loading={busy} />
        </View>
      )}

      {candidate.assignmentStatus === "selected" && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Прекратить переговоры" variant="secondary" onPress={handleCancelNegotiation} loading={busy} />
        </View>
      )}

      {candidate.assignmentStatus === "in_progress" && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Выполнено" onPress={handleComplete} loading={busy} />
          <PrimaryButton label="Не выполнено" variant="secondary" onPress={handleNotCompleted} loading={busy} />
        </View>
      )}

      <ReportAndBlockRow userId={candidate.executorId} />
    </View>
  );
}

function ContactActions({ contact }: { contact: OrderContact }) {
  return (
    <View style={styles.rowActions}>
      <Pressable
        style={({ pressed }) => [styles.contactButton, styles.contactButtonCall, pressed && styles.pressed]}
        onPress={() => Linking.openURL(`tel:${contact.phone}`)}
      >
        <Text style={styles.contactButtonCallText}>Позвонить</Text>
      </Pressable>
      {/* Если отдельный номер WhatsApp не указан, пишем на основной номер телефона. */}
      <Pressable
        style={({ pressed }) => [styles.contactButton, styles.contactButtonWhatsapp, pressed && styles.pressed]}
        onPress={() => Linking.openURL(`https://wa.me/${(contact.whatsappPhone ?? contact.phone).replace(/[^\d]/g, "")}`)}
      >
        <Text style={styles.contactButtonWhatsappText}>WhatsApp</Text>
      </Pressable>
    </View>
  );
}

/** Раздел 28 ТЗ: жалоба на сам заказ. */
function ReportOrderLink({ orderId }: { orderId: string }) {
  const [reportOpen, setReportOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setReportOpen(true)} hitSlop={6}>
        <Text style={styles.mutedLink}>Пожаловаться на заказ</Text>
      </Pressable>
      <ReportModal visible={reportOpen} onClose={() => setReportOpen(false)} targetType="order" targetId={orderId} />
    </>
  );
}

function StatusBadge({ label }: { label: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Кандидат / исполнитель
// ---------------------------------------------------------------------------

function CandidateView({ orderId, simpleTask = false }: { orderId: string; simpleTask?: boolean }) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({ queryKey: ["order-view", orderId], queryFn: () => getOrderView(orderId), refetchInterval: 10_000 });
  const responsesQuery = useQuery({ queryKey: myKeys.response(orderId), queryFn: () => getMyResponse(orderId), refetchInterval: 10_000 });
  const myResponse: MyResponseItem | null | undefined = responsesQuery.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["my-responses"] });
    void queryClient.invalidateQueries({ queryKey: ["order-candidates", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["order-view", orderId] });
  };

  if (responsesQuery.isLoading || detailQuery.isLoading) return <ActivityIndicator color={colors.primary} style={styles.spinner} />;
  if (responsesQuery.isError || detailQuery.isError || !detailQuery.data) return <View style={styles.errorBox}>
    <Text style={styles.error}>Не удалось загрузить заказ или отклик. Заказ может быть недоступен.</Text>
    <PrimaryButton label="Повторить" onPress={() => { void detailQuery.refetch(); void responsesQuery.refetch(); }} />
  </View>;
  const detail = detailQuery.data;

  return (
    <View style={styles.gap}>
      <OrderHeaderBlock
        title={detail.title ?? myResponse?.orderTitle ?? null}
        description={detail.description}
        photoMediaIds={detail.photoMediaIds}
      />
      <View style={styles.metaRow}>
        <Text style={styles.price}>{formatPrice(detail.priceMinor)}</Text>
        {detail.cityName && <Text style={styles.hint}>{detail.cityName}</Text>}
      </View>
      <ReportOrderLink orderId={orderId} />
      {simpleTask && <SimpleTaskNotice title={detail.title ?? myResponse?.orderTitle ?? null} />}

      <View style={styles.divider} />

      {myResponse?.status === "withdrawn" && !myResponse.assignmentStatus && (
        <Text style={styles.hint}>Вы отозвали отклик. Можно откликнуться снова.</Text>
      )}
      {detail.acceptingResponses === false && ["published", "negotiating"].includes(detail.status) &&
        (!myResponse || (myResponse.status === "withdrawn" && !myResponse.assignmentStatus)) && (
        <Text style={styles.hint}>Заказчик больше не принимает отклики на этот заказ.</Text>
      )}
      {detail.canRespond && (!myResponse || (myResponse.status === "withdrawn" && !myResponse.assignmentStatus)) && <ResponseForm orderId={orderId} onCreated={invalidate} acceptsPriceOffers={!!detail.acceptsPriceOffers} />}

      {myResponse && myResponse.status !== "withdrawn" && (
        <MyResponsePanel orderId={orderId} response={myResponse} onChanged={invalidate} acceptsPriceOffers={!!detail.acceptsPriceOffers} />
      )}
    </View>
  );
}

function ResponseForm({ orderId, onCreated, acceptsPriceOffers }: { orderId: string; onCreated: () => void; acceptsPriceOffers: boolean }) {
  const inFlight = useRef(false);
  const [priceText, setPriceText] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (inFlight.current) return;
    const price = acceptsPriceOffers ? parsePriceInput(priceText) : ({ kind: "empty" } as const);
    if (price.kind === "invalid") { setError(PRICE_INPUT_ERROR); return; }
    inFlight.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const offeredPriceMinor = price.kind === "ok" ? price.minor : undefined;
      await createResponse(orderId, {
        offeredPriceMinor,
        comment: comment.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить отклик.");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.gap}>
      <Text style={styles.sectionTitle}>Откликнуться</Text>
      {acceptsPriceOffers && (
        <>
          <Text style={styles.label}>Ваша цена, ₽ (необязательно)</Text>
          <TextInput style={styles.input} value={priceText} onChangeText={setPriceText} keyboardType="numeric" placeholder="Например, 2000" />
        </>
      )}
      <Text style={styles.label}>Комментарий</Text>
      <TextInput style={styles.textArea} value={comment} onChangeText={setComment} multiline />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton label="Отправить отклик" onPress={handleSubmit} loading={submitting} />
    </View>
  );
}

function MyResponsePanel({
  orderId,
  response,
  onChanged,
  acceptsPriceOffers,
}: {
  orderId: string;
  response: MyResponseItem;
  onChanged: () => void;
  acceptsPriceOffers: boolean;
}) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState<OrderContact | null>(null);

  // UX-аудит 2026-09-22, п.3: раньше поправить уже отправленный отклик
  // (например, быстрый пустой отклик из ленты) можно было только отозвав
  // его и создав заново — теперь редактируем на месте через PATCH
  // /responses/{id} (бэкенд уже это умел, мобильный клиент не пользовался).
  const [editing, setEditing] = useState(false);
  const [editPriceText, setEditPriceText] = useState(response.offeredPriceMinor != null ? String(response.offeredPriceMinor / 100) : "");
  const [editComment, setEditComment] = useState(response.comment ?? "");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const handleWithdraw = () => {
    Alert.alert("Отозвать отклик?", undefined, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Отозвать",
        style: "destructive",
        onPress: async () => {
          if (inFlight.current) return;
          inFlight.current = true;
          setError(null);
          setBusy(true);
          try {
            await withdrawResponse(response.id);
            onChanged();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не удалось отозвать отклик.");
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        },
      },
    ]);
  };

  const openEdit = () => {
    setEditError(null);
    setEditPriceText(response.offeredPriceMinor != null ? String(response.offeredPriceMinor / 100) : "");
    setEditComment(response.comment ?? "");
    setEditing(true);
  };

  const handleSaveEdit = async () => {
    if (inFlight.current) return;
    // Цена: пусто — снять цену; неразборчивый ввод — ошибка без запроса, прежняя цена не трогается (F06).
    const price = acceptsPriceOffers ? parsePriceInput(editPriceText) : ({ kind: "empty" } as const);
    if (price.kind === "invalid") { setEditError(PRICE_INPUT_ERROR); return; }
    inFlight.current = true;
    setEditError(null);
    setEditBusy(true);
    try {
      const offeredPriceMinor = price.kind === "ok" ? price.minor : null;
      await updateResponse(response.id, {
        offeredPriceMinor,
        comment: editComment.trim() || null,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Не удалось сохранить изменения.");
    } finally {
      inFlight.current = false;
      setEditBusy(false);
    }
  };

  // Security-этап «исполнитель не должен зависать в работе» (2026-09-22):
  // отметка не завершает заказ — только сигнал заказчику, окончательное
  // решение по-прежнему за ним (кнопки «Выполнено»/«Не выполнено»).
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const handleReportCompleted = async () => {
    if (!response.assignmentId || inFlight.current) return;
    inFlight.current = true;
    setReportError(null);
    setReportBusy(true);
    try {
      await reportAssignmentCompleted(orderId, response.assignmentId);
      onChanged();
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Не удалось отправить отметку.");
    } finally {
      inFlight.current = false;
      setReportBusy(false);
    }
  };

  const handleReportIssue = () => {
    Alert.alert("Сообщить, что не получилось выполнить?", "Заказчик увидит это и примет решение по заказу.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Сообщить",
        style: "destructive",
        onPress: async () => {
          if (!response.assignmentId || inFlight.current) return;
          inFlight.current = true;
          setReportError(null);
          setReportBusy(true);
          try {
            await reportAssignmentIssue(orderId, response.assignmentId);
            onChanged();
          } catch (err) {
            setReportError(err instanceof Error ? err.message : "Не удалось отправить сообщение.");
          } finally {
            inFlight.current = false;
            setReportBusy(false);
          }
        },
      },
    ]);
  };

  // Контакт заказчика подгружается сам, как только раскрыт: «Позвонить / WhatsApp» — как у заказчика.
  useEffect(() => {
    if (!response.isContactUnlocked || !response.orderAuthorId) return;
    let cancelled = false;
    getOrderContact(orderId, response.orderAuthorId)
      .then((c) => {
        if (!cancelled) setContact(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orderId, response.isContactUnlocked, response.orderAuthorId]);

  return (
    <View style={styles.gap}>
      <Text style={styles.sectionTitle}>Ваш отклик</Text>
      <View style={styles.metaRow}>
        <StatusBadge
          label={
            response.status === "active" ? "Ожидает решения" : response.status === "withdrawn" ? "Отозван" : "Не выбран"
          }
        />
        {response.assignmentStatus && <StatusBadge label={ASSIGNMENT_LABELS[response.assignmentStatus]} />}
      </View>

      {!editing && response.offeredPriceMinor != null && <Text style={styles.body}>Ваша цена: {formatPrice(response.offeredPriceMinor)}</Text>}
      {!editing && response.comment && <Text style={styles.body}>{response.comment}</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      {editing && (
        <View style={styles.gap}>
          {acceptsPriceOffers && (
            <>
              <Text style={styles.label}>Ваша цена, ₽ (необязательно)</Text>
              <TextInput style={styles.input} value={editPriceText} onChangeText={setEditPriceText} keyboardType="numeric" placeholder="Например, 2000" />
            </>
          )}
          <Text style={styles.label}>Комментарий</Text>
          <TextInput style={styles.textArea} value={editComment} onChangeText={setEditComment} multiline />
          {editError && <Text style={styles.error}>{editError}</Text>}
          <View style={styles.rowActions}>
            <PrimaryButton label="Сохранить" onPress={handleSaveEdit} loading={editBusy} />
            <PrimaryButton label="Отмена" variant="secondary" onPress={() => setEditing(false)} disabled={editBusy} />
          </View>
        </View>
      )}

      {!editing && response.status === "active" && !response.assignmentStatus && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Изменить" variant="secondary" onPress={openEdit} />
          <PrimaryButton label="Отозвать отклик" variant="secondary" onPress={handleWithdraw} loading={busy} />
        </View>
      )}

      {response.isContactUnlocked && contact && <ContactActions contact={contact} />}

      {/* Security-этап 2026-09-22: см. комментарий в CandidateRow выше — та же идея, с другой стороны. */}
      {response.assignmentStatus === "in_progress" && !response.executorReport && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Работа выполнена" onPress={handleReportCompleted} loading={reportBusy} />
          <PrimaryButton label="Не получилось выполнить" variant="secondary" onPress={handleReportIssue} loading={reportBusy} />
        </View>
      )}
      {response.assignmentStatus === "in_progress" && response.executorReport === "completed" && (
        <Text style={styles.hint}>Вы отметили работу выполненной. Ждём подтверждения заказчика.</Text>
      )}
      {response.assignmentStatus === "in_progress" && response.executorReport === "issue" && (
        <Text style={styles.hint}>Вы сообщили, что не получилось выполнить. Заказчик примет решение по заказу.</Text>
      )}
      {reportError && <Text style={styles.error}>{reportError}</Text>}

      {response.orderAuthorId && <ReportAndBlockRow userId={response.orderAuthorId} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  spinner: { marginTop: spacing.lg },
  gap: { gap: spacing.sm },
  title: { ...typography.title, color: colors.textPrimary },
  description: { ...typography.body, color: colors.textSecondary },
  body: { ...typography.body, color: colors.textPrimary },
  hint: { ...typography.caption, color: colors.textSecondary },
  label: { ...typography.caption, color: colors.textSecondary },
  matchExplanation: { ...typography.caption, color: colors.primary },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  price: { ...typography.title, fontSize: 20, fontWeight: "800", color: colors.primary },
  divider: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.xs },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  photoThumb: { width: 72, height: 72, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt },
  sectionTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  errorBox: { gap: spacing.xs },
  error: { ...typography.caption, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  reportHintSuccess: { ...typography.caption, fontWeight: "600", color: colors.success },
  reportHintIssue: { ...typography.caption, fontWeight: "600", color: colors.danger },
  mutedLink: { ...typography.caption, color: colors.textTertiary },
  badge: { backgroundColor: colors.primaryTintBg, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 5 },
  badgeText: { ...typography.caption, fontWeight: "700", color: colors.primary },
  candidateCard: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  candidateName: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  rowActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  pressed: { opacity: 0.85 },
  contactButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: radii.button,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  contactButtonCall: { backgroundColor: colors.primaryTintBg },
  contactButtonCallText: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
  contactButtonWhatsapp: { backgroundColor: colors.successTintBg },
  contactButtonWhatsappText: { ...typography.subtitle, fontWeight: "700", color: colors.success },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
  },
  textArea: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
    minHeight: 72,
    textAlignVertical: "top",
  },
  reviewBox: { gap: spacing.sm, marginTop: spacing.xs },
  starsRow: { flexDirection: "row", gap: spacing.xs },
  star: { fontSize: 28, color: colors.border },
  starActive: { color: colors.star },
});
