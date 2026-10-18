import { useRef, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HomeHeader } from "../../src/components/HomeHeader";
import { useNotificationBadges } from "../../src/notifications/badges";
import { QuickActions } from "../../src/components/QuickActions";
import { OrderCard } from "../../src/components/OrderCard";
import { ContactButtons } from "../../src/components/ContactButtons";
import { getFeed } from "../../src/api/feed";
import { getMyResponses } from "../../src/api/my";
import { getCities } from "../../src/api/cities";
import { createResponse } from "../../src/api/responses";
import { ApiRequestError } from "@ustal/api-client";
import { colors, spacing, typography } from "../../src/theme/tokens";

/**
 * UX-аудит 2026-09-22, «Важно» №4: раньше любая ошибка отклика из ленты
 * (не только ожидаемое "уже откликался") молча проглатывалась — кнопка
 * просто переставала крутиться, без единого слова пользователю. Теперь
 * код ошибки от API превращается в понятный текст под карточкой.
 */
const RESPOND_ERROR_MESSAGES: Record<string, string> = {
  already_responded: "Вы уже откликнулись на этот заказ.",
  not_found: "Этот заказ больше недоступен.",
  invalid_status: "Заказ больше не принимает отклики.",
  price_offers_disabled: "Заказчик не принимает предложения с другой ценой.",
  forbidden: "Нельзя откликнуться на этот заказ.",
};
const RESPOND_ERROR_FALLBACK = "Не удалось откликнуться. Попробуйте ещё раз.";

/**
 * «Возможности» — лента подобранных AI заказов для исполнителя (раздел 15/26
 * ТЗ, макет Main.dc.html). GET /feed. Один из двух главных экранов нижней
 * навигации — второй см. app/(tabs)/orders.tsx ("Заказы").
 *
 * Кнопки на карточке — как в макете (Main.dc.html / OrderDetail.dc.html):
 * «Откликнуться» сразу создаёт отклик (POST /orders/{id}/responses, без
 * доп. формы — цену/комментарий можно уточнить позже на самом заказе) и
 * превращается в «✓ Откликнулся»; «Скрыть» убирает карточку из ленты
 * локально на этом экране (без отдельного API — как и в макете). Тап по
 * самой карточке по-прежнему открывает полную карточку заказа.
 */
export default function OpportunitiesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [hiddenIds, setHiddenIds] = useState<Record<string, true>>({});
  const responding = useRef(new Set<string>());
  const [respondingIds, setRespondingIds] = useState<Record<string, boolean>>({});
  const refreshInFlight = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [respondErrors, setRespondErrors] = useState<Record<string, string>>({});

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["feed"], queryFn: () => getFeed() });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: getCities });
  const badges = useNotificationBadges();
  const { data: myResponses, refetch: refetchResponses } = useQuery({ queryKey: ["my-responses"], queryFn: () => getMyResponses({ limit: 100 }) });
  const cityName = (cityId: string) => cities?.find((c) => c.id === cityId)?.name ?? cityId;

  // The API permits a new response after withdrawal, retaining the historical row.
  const respondedOrderIds = new Set((myResponses?.items ?? []).filter((r) => r.status !== "withdrawn").map((r) => r.orderId));
  const visibleItems = [...new Map((data?.items ?? []).map((item) => [item.orderId, item])).values()].filter((item) => !hiddenIds[item.orderId]);

  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await Promise.all([refetch(), refetchResponses()]);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };

  const handleRespond = async (orderId: string) => {
    if (responding.current.has(orderId) || respondedOrderIds.has(orderId)) return;
    responding.current.add(orderId);
    setRespondingIds((prev) => ({ ...prev, [orderId]: true }));
    setRespondErrors((prev) => {
      if (!(orderId in prev)) return prev;
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
    try {
      await createResponse(orderId, {});
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : undefined;
      const message = (code && RESPOND_ERROR_MESSAGES[code]) || RESPOND_ERROR_FALLBACK;
      setRespondErrors((prev) => ({ ...prev, [orderId]: message }));
    } finally {
      // Инвалидируем и при ошибке: например, "уже откликался" — состояние
      // должно подтянуться из GET /my/responses, а не просто скрыть ошибку.
      try {
        await queryClient.invalidateQueries({ queryKey: ["my-responses"] });
      } finally {
        responding.current.delete(orderId);
        setRespondingIds((prev) => ({ ...prev, [orderId]: false }));
      }
    }
  };

  const handleHide = (orderId: string) => setHiddenIds((prev) => ({ ...prev, [orderId]: true }));

  return (
    <View style={styles.container}>
      <View style={[styles.headerPad, { paddingTop: insets.top + spacing.sm }]}>
        <HomeHeader
          active="opportunities"
          opportunitiesCount={badges.opportunities}
          ordersCount={badges.orders}
        />
      </View>

      {/*
       * Упрощение рейтинга (2026-09-22): раньше здесь был баннер «Оценить»
       * для исполнителя (оценка заказчика) — исполнитель заказчика больше
       * не оценивает, баннер убран вместе с полем ratingPending в
       * MyResponseItem (apps/mobile/src/api/my.ts).
       */}
      <View style={styles.extras}>
        <QuickActions />
        <Pressable onPress={() => void refresh()} disabled={refreshing} accessibilityRole="button">
          <Text style={styles.retry}>{refreshing ? "Обновляем…" : "Обновить"}</Text>
        </Pressable>
      </View>

      {isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить ленту.</Text>
          <Pressable onPress={() => void refresh()} disabled={refreshing}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {data && !isLoading && !isError && visibleItems.length === 0 && (
        <Text style={styles.empty}>Пока нет подходящих заказов — как только AI найдёт совпадение, вы увидите его здесь.</Text>
      )}

      {data && visibleItems.length > 0 && (
        <FlatList
          data={visibleItems}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          keyExtractor={(item) => item.orderId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={styles.cardWrapper}
              onPress={() =>
                router.push({
                  pathname: "/order/[id]",
                  params: {
                    id: item.orderId,
                    title: item.title ?? "",
                    description: item.description ?? "",
                    cityName: cityName(item.cityId),
                    priceMinor: item.priceMinor != null ? String(item.priceMinor) : "",
                    matchType: item.matchType,
                    explanation: item.explanation,
                    photoMediaIds: (item.photoMediaIds ?? []).join(","),
                    acceptsPriceOffers: item.acceptsPriceOffers ? "1" : "",
                  },
                })
              }
            >
              <OrderCard
                title={item.title ?? "Без названия"}
                description={item.description ?? ""}
                cityName={cityName(item.cityId)}
                priceMinor={item.priceMinor}
                matchType={item.matchType}
                explanation={item.explanation}
                photoMediaIds={item.photoMediaIds}
                statusLabel={
                  item.assignmentStatus === "in_progress"
                    ? "В работе"
                    : item.assignmentStatus === "selected"
                      ? "Идут переговоры"
                      : undefined
                }
                contactSlot={item.contactAuthorId ? <ContactButtons orderId={item.orderId} userId={item.contactAuthorId} /> : undefined}
                responded={respondedOrderIds.has(item.orderId)}
                responding={!!respondingIds[item.orderId]}
                respondError={respondErrors[item.orderId] ?? null}
                onRespond={() => handleRespond(item.orderId)}
                onHide={() => handleHide(item.orderId)}
              />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  extras: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  headerPad: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  cardWrapper: { marginBottom: spacing.sm },
  empty: { ...typography.body, color: colors.textSecondary, paddingHorizontal: spacing.lg },
  spinner: { marginTop: spacing.lg },
  errorBox: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
});
