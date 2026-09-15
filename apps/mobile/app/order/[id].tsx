import { useState } from "react";
import { View, Text, Image, StyleSheet, ScrollView, ActivityIndicator, Pressable, TextInput, Linking, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@ustal/api-client";
import { getOrder, retryOrder, publishOrder, cancelOrder } from "../../src/api/orders";
import { getMediaUrl } from "../../src/api/media";
import type { AssignmentStatus, OrderDetail, OrderStatus } from "../../src/api/orders";
import { getOrderCandidates, createResponse, withdrawResponse } from "../../src/api/responses";
import type { OrderCandidate } from "../../src/api/responses";
import { unlockContact, getOrderContact } from "../../src/api/contacts";
import type { OrderContact } from "../../src/api/contacts";
import { selectCandidate, completeAssignment, markAssignmentNotCompleted } from "../../src/api/assignments";
import { submitReview } from "../../src/api/reviews";
import { getMyResponses } from "../../src/api/my";
import type { MyResponseItem } from "../../src/api/my";
import { blockUser } from "../../src/api/blocks";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { ReportModal } from "../../src/components/ReportModal";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const ASSIGNMENT_LABELS: Record<AssignmentStatus, string> = {
  selected: "Выбран",
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
 * кандидата: карточка заказа берётся из параметров, переданных из ленты
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
  const { id, title, description, cityName, priceMinor, matchType, explanation } = useLocalSearchParams<{
    id: string;
    title?: string;
    description?: string;
    cityName?: string;
    priceMinor?: string;
    matchType?: string;
    explanation?: string;
  }>();
  const router = useRouter();

  const orderQuery = useQuery({
    queryKey: ["order", id],
    queryFn: () => getOrder(id),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "processing" && query.state.data.moderationStatus === "pending" ? 3000 : false,
  });

  const isNotAuthor = orderQuery.isError && orderQuery.error instanceof ApiRequestError && orderQuery.error.status === 404;
  const isOtherError = orderQuery.isError && !isNotAuthor;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>

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

      {isNotAuthor && (
        <CandidateView
          orderId={id}
          fallback={{
            title: title ?? null,
            description: description ?? null,
            cityName: cityName ?? null,
            priceMinor: priceMinor ? Number(priceMinor) : null,
            matchType: (matchType as "exact" | "probable" | "new_opportunity" | undefined) || undefined,
            explanation: explanation || undefined,
          }}
        />
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Автор заказа
// ---------------------------------------------------------------------------

function AuthorView({ orderId, order }: { orderId: string; order: OrderDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const candidatesQuery = useQuery({
    queryKey: ["order-candidates", orderId],
    queryFn: () => getOrderCandidates(orderId),
    enabled:
      order.status === "published" ||
      order.status === "negotiating" ||
      order.status === "closed" ||
      order.status === "cancelled",
  });

  const candidates = candidatesQuery.data?.items ?? [];
  // Простое правило вместо новых статусов (задача явно просила не усложнять):
  // «выбран исполнитель» = есть активное (ещё не завершённое) назначение —
  // тогда кнопка снизу «Отменить заказ», иначе, пока ничего не завершено —
  // «Удалить заказ». Если работа уже завершена/отмечена невыполненной,
  // отменять/удалять уже нечего — кнопка не показывается вовсе, действие
  // переходит к существующей логике отзыва в CandidateRow ниже.
  const hasSelectedAssignment = candidates.some((c) => c.assignmentStatus === "selected");
  const hasResolvedAssignment = candidates.some(
    (c) => c.assignmentStatus === "completed" || c.assignmentStatus === "not_completed",
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["order-candidates", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
  };

  /**
   * Удаление/отмена заказа (claude/plan.md, задача 2026-09-14). Один и тот
   * же backend-вызов (POST /orders/{id}/cancel — единственный допустимый
   * переход из published/negotiating, кроме closed/expired, см.
   * packages/domain/src/order.ts) для обеих кнопок: разница только в тексте
   * подтверждения и в том, остаёмся ли на экране. «Удалить» — исполнитель
   * ещё не выбран, поэтому после подтверждения возвращаемся к списку («больше
   * не показывается» в текущем месте); «Отменить» — исполнитель уже выбран,
   * поэтому остаёмся на экране, заказ виден дальше со статусом «Отменён»
   * («остаётся в истории»).
   */
  const handleDelete = () => {
    Alert.alert("Удалить заказ?", "Все отклики будут закрыты.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: async () => {
          setCloseError(null);
          setClosing(true);
          try {
            await cancelOrder(orderId);
            invalidate();
            router.back();
          } catch (err) {
            setCloseError(err instanceof Error ? err.message : "Не удалось удалить заказ.");
            setClosing(false);
          }
        },
      },
    ]);
  };

  const handleCancel = () => {
    Alert.alert("Отменить заказ?", "Исполнитель получит уведомление.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Отменить заказ",
        style: "destructive",
        onPress: async () => {
          setCloseError(null);
          setClosing(true);
          try {
            await cancelOrder(orderId);
            invalidate();
          } catch (err) {
            setCloseError(err instanceof Error ? err.message : "Не удалось отменить заказ.");
          } finally {
            setClosing(false);
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.gap}>
      <Text style={styles.title}>{order.normalizedTitle ?? "Заказ"}</Text>
      {order.normalizedDescription && <Text style={styles.description}>{order.normalizedDescription}</Text>}
      <View style={styles.metaRow}>
        <Text style={styles.price}>{formatPrice(order.priceMinor)}</Text>
        <StatusBadge label={ORDER_STATUS_LABELS[order.status]} />
      </View>

      {order.status === "processing" && (
        order.moderationStatus === "pending" ? <Text style={styles.hint}>Заказ обрабатывается AI…</Text> :
        (order.moderationStatus === "allow" || order.moderationStatus === "allow_with_warning") &&
        <PrimaryButton label="Опубликовать" loading={closing} onPress={async () => {
          setClosing(true); setCloseError(null);
          try { await publishOrder(orderId); invalidate(); }
          catch { setCloseError("Не удалось опубликовать заказ."); }
          finally { setClosing(false); }
        }} />
      )}
      {order.status === "processing_failed" && <PrimaryButton label="Повторить обработку" loading={closing} onPress={async () => {
        setClosing(true); setCloseError(null);
        try { await retryOrder(orderId); invalidate(); }
        catch { setCloseError("Не удалось повторить обработку."); }
        finally { setClosing(false); }
      }} />}
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
      {order.photoMediaIds.length > 0 && (
        <View style={styles.photoRow}>
          {order.photoMediaIds.map((mediaId) => (
            <Image key={mediaId} source={{ uri: getMediaUrl(mediaId) }} style={styles.photoThumb} />
          ))}
        </View>
      )}

      {(order.status === "published" ||
        order.status === "negotiating" ||
        order.status === "closed" ||
        order.status === "cancelled") && (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Кандидаты</Text>

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

          {(order.status === "published" || order.status === "negotiating") && !hasResolvedAssignment && (
            <>
              {closeError && <Text style={styles.error}>{closeError}</Text>}
              {hasSelectedAssignment ? (
                <PrimaryButton label="Отменить заказ" variant="secondary" onPress={handleCancel} loading={closing} />
              ) : (
                <PrimaryButton label="Удалить заказ" variant="secondary" onPress={handleDelete} loading={closing} />
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "Черновик",
  processing: "Обрабатывается",
  processing_failed: "Ошибка обработки",
  moderation_hold: "На проверке",
  published: "Опубликован",
  negotiating: "Идут переговоры",
  closed: "Закрыт",
  expired: "Истёк",
  cancelled: "Отменён",
  rejected: "Отклонён",
};

function CandidateRow({
  orderId,
  orderStatus,
  candidate,
  onChanged,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  candidate: OrderCandidate;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [contact, setContact] = useState<OrderContact | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setRowError(null);
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Не удалось выполнить действие.");
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = () => run(() => unlockContact(orderId, candidate.id));
  const handleReveal = () =>
    run(async () => {
      const c = await getOrderContact(orderId, candidate.executorId);
      setContact(c);
    });
  const handleSelect = () => run(() => selectCandidate(orderId, candidate.id));
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
        <Text style={styles.candidateName}>{candidate.executorName ?? "Исполнитель"}</Text>
        {candidate.assignmentStatus && <StatusBadge label={ASSIGNMENT_LABELS[candidate.assignmentStatus]} />}
      </View>
      {candidate.offeredPriceMinor != null && <Text style={styles.body}>Предложил: {formatPrice(candidate.offeredPriceMinor)}</Text>}
      {candidate.comment && <Text style={styles.body}>{candidate.comment}</Text>}
      {candidate.availabilityText && <Text style={styles.hint}>Доступность: {candidate.availabilityText}</Text>}
      {candidate.status === "withdrawn" && <Text style={styles.hint}>Отклик отозван</Text>}
      {/*
       * "not_selected" теперь ставится в двух разных случаях: обычное
       * закрытие заказа с выбором другого кандидата И отмена заказа
       * (POST /orders/{id}/cancel, см. apps/api/src/routes/orders.ts) —
       * старая формулировка называла причину только для первого случая
       * (UX-аудит, docs/evaluations/matching-ux-audit.md, MVP-правка 3).
       */}
      {candidate.status === "not_selected" && (
        <Text style={styles.hint}>
          {orderStatus === "cancelled" || candidate.assignmentStatus === "cancelled"
            ? "Отменено"
            : "Не выбран при закрытии заказа"}
        </Text>
      )}

      {rowError && <Text style={styles.error}>{rowError}</Text>}

      {candidate.status === "active" && !candidate.assignmentId && (
        <View style={styles.rowActions}>
          {!candidate.isContactUnlocked && (
            <PrimaryButton label="Раскрыть контакт" variant="secondary" onPress={handleUnlock} loading={busy} />
          )}
          {candidate.isContactUnlocked && (
            <PrimaryButton label="Выбрать исполнителя" onPress={handleSelect} loading={busy} />
          )}
        </View>
      )}

      {candidate.isContactUnlocked && (
        <>
          {!contact ? (
            <Pressable onPress={handleReveal} disabled={busy}>
              <Text style={styles.retry}>Показать контакт</Text>
            </Pressable>
          ) : (
            <ContactActions contact={contact} />
          )}
        </>
      )}

      {candidate.assignmentStatus === "selected" && (
        <View style={styles.rowActions}>
          <PrimaryButton label="Выполнено" onPress={handleComplete} loading={busy} />
          <PrimaryButton label="Не выполнено" variant="secondary" onPress={handleNotCompleted} loading={busy} />
        </View>
      )}

      {candidate.assignmentStatus === "completed" && (
        <>
          <Pressable onPress={() => setReviewOpen((v) => !v)}>
            <Text style={styles.retry}>{reviewOpen ? "Скрыть отзыв" : "Оставить отзыв"}</Text>
          </Pressable>
          {reviewOpen && <ReviewForm orderId={orderId} toUserId={candidate.executorId} onDone={() => setReviewOpen(false)} />}
        </>
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
      {contact.whatsappPhone && (
        <Pressable
          style={({ pressed }) => [styles.contactButton, styles.contactButtonWhatsapp, pressed && styles.pressed]}
          onPress={() => Linking.openURL(`https://wa.me/${contact.whatsappPhone!.replace(/[^\d]/g, "")}`)}
        >
          <Text style={styles.contactButtonWhatsappText}>WhatsApp</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Раздел 28/29 ТЗ: жалоба и блокировка конкретного человека — контекстные действия, не отдельный экран. */
function ReportAndBlockRow({ userId }: { userId: string }) {
  const [reportOpen, setReportOpen] = useState(false);

  const handleBlock = () => {
    Alert.alert("Заблокировать пользователя?", "Вы больше не будете видеть заказы и отклики друг друга.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Заблокировать",
        style: "destructive",
        onPress: () => {
          void blockUser(userId).catch(() => {});
        },
      },
    ]);
  };

  return (
    <View style={styles.rowActions}>
      <Pressable onPress={() => setReportOpen(true)} hitSlop={6}>
        <Text style={styles.mutedLink}>Пожаловаться</Text>
      </Pressable>
      <Pressable onPress={handleBlock} hitSlop={6}>
        <Text style={styles.mutedLink}>Заблокировать</Text>
      </Pressable>
      <ReportModal visible={reportOpen} onClose={() => setReportOpen(false)} targetType="user" targetId={userId} />
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

function ReviewForm({ orderId, toUserId, onDone }: { orderId: string; toUserId: string; onDone: () => void }) {
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await submitReview({ toUserId, orderId, rating, text: text.trim() || undefined });
      setDone(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить отзыв.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) return <Text style={styles.hint}>Отзыв отправлен, спасибо.</Text>;

  return (
    <View style={styles.reviewBox}>
      <View style={styles.starsRow}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setRating(n)} hitSlop={6}>
            <Text style={[styles.star, n <= rating && styles.starActive]}>★</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.textArea}
        value={text}
        onChangeText={setText}
        placeholder="Комментарий (необязательно)"
        multiline
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton label="Отправить отзыв" onPress={handleSubmit} loading={submitting} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Кандидат / исполнитель
// ---------------------------------------------------------------------------

interface FeedFallback {
  title: string | null;
  description: string | null;
  cityName: string | null;
  priceMinor: number | null;
  matchType?: "exact" | "probable" | "new_opportunity";
  explanation?: string;
}

function CandidateView({ orderId, fallback }: { orderId: string; fallback: FeedFallback }) {
  const queryClient = useQueryClient();
  const responsesQuery = useQuery({
    queryKey: ["my-responses"],
    queryFn: () => getMyResponses({ limit: 50 }),
  });

  const myResponse: MyResponseItem | undefined = responsesQuery.data?.items.find((r) => r.orderId === orderId);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["my-responses"] });

  if (responsesQuery.isLoading) return <ActivityIndicator color={colors.primary} style={styles.spinner} />;

  return (
    <View style={styles.gap}>
      <Text style={styles.title}>{myResponse?.orderTitle ?? fallback.title ?? "Заказ"}</Text>
      {fallback.description && <Text style={styles.description}>{fallback.description}</Text>}
      <View style={styles.metaRow}>
        <Text style={styles.price}>{formatPrice(fallback.priceMinor)}</Text>
        {fallback.cityName && <Text style={styles.hint}>{fallback.cityName}</Text>}
      </View>
      {fallback.explanation && <Text style={styles.matchExplanation}>{fallback.explanation}</Text>}
      <ReportOrderLink orderId={orderId} />

      <View style={styles.divider} />

      {!myResponse && <ResponseForm orderId={orderId} onCreated={invalidate} />}

      {myResponse && <MyResponsePanel orderId={orderId} response={myResponse} onChanged={invalidate} />}
    </View>
  );
}

function ResponseForm({ orderId, onCreated }: { orderId: string; onCreated: () => void }) {
  const [priceText, setPriceText] = useState("");
  const [comment, setComment] = useState("");
  const [availabilityText, setAvailabilityText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const offeredPriceMinor = priceText.trim() ? Math.round(Number(priceText.trim()) * 100) : undefined;
      await createResponse(orderId, {
        offeredPriceMinor,
        comment: comment.trim() || undefined,
        availabilityText: availabilityText.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить отклик.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.gap}>
      <Text style={styles.sectionTitle}>Откликнуться</Text>
      <Text style={styles.label}>Ваша цена, ₽ (необязательно)</Text>
      <TextInput style={styles.input} value={priceText} onChangeText={setPriceText} keyboardType="numeric" placeholder="Например, 2000" />
      <Text style={styles.label}>Комментарий</Text>
      <TextInput style={styles.textArea} value={comment} onChangeText={setComment} multiline placeholder="Почему вы подходите" />
      <Text style={styles.label}>Доступность</Text>
      <TextInput style={styles.input} value={availabilityText} onChangeText={setAvailabilityText} placeholder="Например, сегодня после 18:00" />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton label="Отправить отклик" onPress={handleSubmit} loading={submitting} />
    </View>
  );
}

function MyResponsePanel({ orderId, response, onChanged }: { orderId: string; response: MyResponseItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState<OrderContact | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const handleWithdraw = () => {
    Alert.alert("Отозвать отклик?", undefined, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Отозвать",
        style: "destructive",
        onPress: async () => {
          setError(null);
          setBusy(true);
          try {
            await withdrawResponse(response.id);
            onChanged();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не удалось отозвать отклик.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const handleReveal = async () => {
    if (!response.orderAuthorId) return;
    setError(null);
    setBusy(true);
    try {
      const c = await getOrderContact(orderId, response.orderAuthorId);
      setContact(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось получить контакт.");
    } finally {
      setBusy(false);
    }
  };

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
      {response.offeredPriceMinor != null && <Text style={styles.body}>Ваша цена: {formatPrice(response.offeredPriceMinor)}</Text>}
      {response.comment && <Text style={styles.body}>{response.comment}</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      {response.status === "active" && !response.assignmentStatus && (
        <PrimaryButton label="Отозвать отклик" variant="secondary" onPress={handleWithdraw} loading={busy} />
      )}

      {response.isContactUnlocked && (
        <>
          {!contact ? (
            <PrimaryButton label="Показать контакт заказчика" variant="secondary" onPress={handleReveal} loading={busy} />
          ) : (
            <ContactActions contact={contact} />
          )}
        </>
      )}

      {response.assignmentStatus === "completed" && response.orderAuthorId && (
        <>
          <Pressable onPress={() => setReviewOpen((v) => !v)}>
            <Text style={styles.retry}>{reviewOpen ? "Скрыть отзыв" : "Оставить отзыв"}</Text>
          </Pressable>
          {reviewOpen && <ReviewForm orderId={orderId} toUserId={response.orderAuthorId} onDone={() => setReviewOpen(false)} />}
        </>
      )}

      {response.orderAuthorId && <ReportAndBlockRow userId={response.orderAuthorId} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
