import { useRef, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNotificationBadges } from "../../src/notifications/badges";
import { OrderCard } from "../../src/components/OrderCard";
import { ContactButtons } from "../../src/components/ContactButtons";
import { CreateOrderComposer } from "../../src/components/CreateOrderComposer";
import { getFeed } from "../../src/api/feed";
import { getMe } from "../../src/api/me";
import { getMyResponses } from "../../src/api/my";
import { getCities } from "../../src/api/cities";
import { createResponse } from "../../src/api/responses";
import { ApiRequestError } from "@ustal/api-client";
import { colors, radii, spacing, typography } from "../../src/theme/tokens";

/**
 * UX-аудит 2026-09-22, «Важно» №4: код ошибки отклика из ленты превращается в понятный текст под карточкой.
 */
const RESPOND_ERROR_MESSAGES: Record<string, string> = {
  already_responded: "Вы уже откликнулись на этот заказ.",
  not_found: "Этот заказ больше недоступен.",
  invalid_status: "Заказ больше не принимает отклики.",
  price_offers_disabled: "Заказчик не принимает предложения с другой ценой.",
  forbidden: "Нельзя откликнуться на этот заказ.",
};
const RESPOND_ERROR_FALLBACK = "Не удалось откликнуться. Попробуйте ещё раз.";
const FEED_PAGE = 20;

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

/**
 * «Главная» (новый интерфейс 2026-10-28, утверждённый прототип): закреплённая шапка «Ваши возможности»,
 * под ней бесконечная лента подобранных AI заказов (GET /feed постранично, limit/offset — контракт не менялся),
 * внизу — поле «Что вам нужно сделать?» (тот же переход к созданию заказа, что и на «Заказах»).
 * Логика карточки прежняя: «Откликнуться» сразу создаёт отклик (POST /orders/{id}/responses) → «✓ Откликнулся»;
 * «Скрыть» убирает карточку локально; при переговорах/работе — статус и «Позвонить / WhatsApp» (OrderCard).
 * «Мои отклики» и «История» перенесены во вкладку «Заказы».
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

  const feed = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }) => getFeed({ limit: FEED_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.items.length < last.limit ? undefined : last.offset + last.limit),
  });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: getCities, staleTime: Infinity });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });
  const badges = useNotificationBadges();
  const { data: myResponses, refetch: refetchResponses } = useQuery({ queryKey: ["my-responses"], queryFn: () => getMyResponses({ limit: 100 }) });
  const cityName = (cityId: string) => cities?.find((c) => c.id === cityId)?.name ?? cityId;

  const firstName = me?.name?.trim().split(/\s+/)[0];
  const myCity = cities?.find((c) => c.id === me?.cityId)?.name;
  const subtitle = [firstName ? `${greeting()}, ${firstName}` : greeting(), myCity].filter(Boolean).join(" · ");

  // The API permits a new response after withdrawal, retaining the historical row.
  const respondedOrderIds = new Set((myResponses?.items ?? []).filter((r) => r.status !== "withdrawn").map((r) => r.orderId));
  const allItems = (feed.data?.pages ?? []).flatMap((p) => p.items);
  const visibleItems = [...new Map(allItems.map((item) => [item.orderId, item])).values()].filter((item) => !hiddenIds[item.orderId]);

  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await Promise.all([feed.refetch(), refetchResponses()]);
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
      // Инвалидируем и при ошибке: состояние должно подтянуться из GET /my/responses.
      try {
        await queryClient.invalidateQueries({ queryKey: ["my-responses"] });
      } finally {
        responding.current.delete(orderId);
        setRespondingIds((prev) => ({ ...prev, [orderId]: false }));
      }
    }
  };

  const handleHide = (orderId: string) => setHiddenIds((prev) => ({ ...prev, [orderId]: true }));
  const loadMore = () => { if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage(); };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">Ваши возможности</Text>
          {badges.opportunities > 0 && (
            <View style={styles.countChip} accessible accessibilityLabel={`Новых событий по откликам: ${badges.opportunities}`}>
              <Text style={styles.countText}>{badges.opportunities}</Text>
            </View>
          )}
        </View>
      </View>

      {feed.isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {feed.isError && !feed.data && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить ленту.</Text>
          <Pressable onPress={() => void refresh()} disabled={refreshing} accessibilityRole="button">
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {feed.data && !feed.isLoading && visibleItems.length === 0 && (
        <View style={styles.emptyBox}>
          <Text style={styles.empty}>{feed.hasNextPage ? "Все загруженные заказы скрыты. Можно посмотреть следующие." : "Пока нет подходящих заказов — как только AI найдёт совпадение, вы увидите его здесь."}</Text>
          <Pressable onPress={() => router.push("/(tabs)/profile")} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.retry}>Изменить навыки и ресурсы</Text>
          </Pressable>
        </View>
      )}

      {feed.data && (
        <FlatList
          style={styles.flex}
          data={visibleItems}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          keyExtractor={(item) => item.orderId}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Pressable style={styles.refreshLink} onPress={() => void refresh()} disabled={refreshing} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.refreshText}>{refreshing ? "Обновляем…" : "Обновить"}</Text>
            </Pressable>
          }
          ListFooterComponent={
            feed.isFetchingNextPage ? (
              <View style={styles.footer}><ActivityIndicator color={colors.primary} /><Text style={styles.footerText}>Подбираем ещё заказы…</Text></View>
            ) : feed.isError ? (
              <View style={styles.errorBox}>
                <Text style={styles.error}>Не удалось обновить ленту.</Text>
                <Pressable accessibilityRole="button" onPress={() => feed.isFetchNextPageError ? loadMore() : void refresh()}>
                  <Text style={styles.retry}>Повторить загрузку</Text>
                </Pressable>
              </View>
            ) : feed.hasNextPage && visibleItems.length === 0 ? (
              <Pressable accessibilityRole="button" onPress={loadMore}>
                <Text style={styles.retry}>Показать ещё заказы</Text>
              </Pressable>
            ) : !feed.hasNextPage ? (
              <Text style={styles.footerText}>Это все подходящие заказы на сейчас. Новые появятся здесь.</Text>
            ) : null
          }
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

      {!feed.data && <View style={styles.flex} />}
      <CreateOrderComposer placeholder="Что вам нужно сделать?" bottomInset={false} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  subtitle: { ...typography.caption, color: colors.textSecondary },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, marginTop: 2 },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5, color: colors.textPrimary, flexShrink: 1 },
  countChip: { minWidth: 28, height: 24, paddingHorizontal: 8, borderRadius: radii.pill, backgroundColor: colors.primaryTintBg, alignItems: "center", justifyContent: "center" },
  countText: { ...typography.caption, fontWeight: "700", color: colors.primary },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  cardWrapper: { marginBottom: spacing.sm },
  refreshLink: { alignSelf: "flex-end", paddingVertical: spacing.sm },
  refreshText: { ...typography.caption, color: colors.primary, fontWeight: "600" },
  emptyBox: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  empty: { ...typography.body, color: colors.textSecondary },
  spinner: { marginTop: spacing.lg },
  errorBox: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  footer: { alignItems: "center", gap: spacing.xs, paddingVertical: spacing.md },
  footerText: { ...typography.caption, color: colors.textSecondary, textAlign: "center", paddingVertical: spacing.md },
});
