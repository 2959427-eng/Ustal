import { useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HomeHeader } from "../../src/components/HomeHeader";
import { OrderCard } from "../../src/components/OrderCard";
import { getFeed } from "../../src/api/feed";
import { getMyOrders, getMyResponses } from "../../src/api/my";
import { getCities } from "../../src/api/cities";
import { createResponse } from "../../src/api/responses";
import { colors, spacing, typography } from "../../src/theme/tokens";

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
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["feed"], queryFn: () => getFeed() });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: getCities });
  const { data: myOrders } = useQuery({ queryKey: ["my-orders"], queryFn: () => getMyOrders() });
  const { data: myResponses } = useQuery({ queryKey: ["my-responses"], queryFn: () => getMyResponses({ limit: 100 }) });
  const cityName = (cityId: string) => cities?.find((c) => c.id === cityId)?.name ?? cityId;

  const respondedOrderIds = new Set((myResponses?.items ?? []).map((r) => r.orderId));
  const visibleItems = (data?.items ?? []).filter((item) => !hiddenIds[item.orderId]);

  const handleRespond = async (orderId: string) => {
    setRespondingId(orderId);
    try {
      await createResponse(orderId, {});
      void queryClient.invalidateQueries({ queryKey: ["my-responses"] });
    } catch {
      // Тихо игнорируем (например, "уже откликался") — состояние подтянется из GET /my/responses.
    } finally {
      setRespondingId(null);
    }
  };

  const handleHide = (orderId: string) => setHiddenIds((prev) => ({ ...prev, [orderId]: true }));

  return (
    <View style={styles.container}>
      <View style={[styles.headerPad, { paddingTop: insets.top + spacing.sm }]}>
        <HomeHeader
          active="opportunities"
          opportunitiesCount={visibleItems.length}
          ordersCount={myOrders?.items.length}
        />
      </View>

      {isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить ленту.</Text>
          <Pressable onPress={() => refetch()}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {data && visibleItems.length === 0 && (
        <Text style={styles.empty}>Пока нет подходящих заказов — как только AI найдёт совпадение, вы увидите его здесь.</Text>
      )}

      {data && visibleItems.length > 0 && (
        <FlatList
          data={visibleItems}
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
                responded={respondedOrderIds.has(item.orderId)}
                responding={respondingId === item.orderId}
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
  headerPad: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  cardWrapper: { marginBottom: spacing.sm },
  empty: { ...typography.body, color: colors.textSecondary, paddingHorizontal: spacing.lg },
  spinner: { marginTop: spacing.lg },
  errorBox: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
});
