import { useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { OrderCard } from "../../src/components/OrderCard";
import { getFeed } from "../../src/api/feed";
import { getMyOrders, type MyOrderItem } from "../../src/api/my";
import { getCities } from "../../src/api/cities";
import type { OrderStatus } from "../../src/api/orders";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

type Tab = "feed" | "mine";

const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Черновик",
  processing: "Обрабатывается",
  moderation_hold: "На проверке",
  published: "Опубликован",
  negotiating: "Идут переговоры",
  closed: "Закрыт",
  expired: "Истёк",
  cancelled: "Отменён",
  rejected: "Отклонён",
};

/**
 * «Заказы»: два режима одного и того же таба (раздел 15/19/26 ТЗ) — тот же
 * аккаунт без выбора роли одновременно и заказчик, и исполнитель
 * (architecture.md §2). «Лента» — GET /feed (подобранные AI заказы, с
 * объяснением совпадения, без счётчика исполнителей — architecture.md §5
 * п.6). «Мои заказы» — GET /my/orders, то, что опубликовал сам.
 */
export default function OrdersScreen() {
  const [tab, setTab] = useState<Tab>("feed");

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        <SegmentButton label="Лента" active={tab === "feed"} onPress={() => setTab("feed")} />
        <SegmentButton label="Мои заказы" active={tab === "mine"} onPress={() => setTab("mine")} />
      </View>
      {tab === "feed" ? <FeedList /> : <MyOrdersList />}
    </View>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.segment, active && styles.segmentActive]} onPress={onPress}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function FeedList() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["feed"],
    queryFn: () => getFeed(),
  });
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: getCities });
  const cityName = (cityId: string) => cities?.find((c) => c.id === cityId)?.name ?? cityId;

  if (isLoading) return <ActivityIndicator color={colors.primary} style={styles.spinner} />;
  if (isError) return <ErrorState onRetry={refetch} />;
  if (!data || data.items.length === 0) {
    return <Text style={styles.empty}>Пока нет подходящих заказов — как только AI найдёт совпадение, вы увидите его здесь.</Text>;
  }

  return (
    <FlatList
      data={data.items}
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
          />
        </Pressable>
      )}
    />
  );
}

function MyOrdersList() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["my-orders"],
    queryFn: () => getMyOrders(),
  });

  if (isLoading) return <ActivityIndicator color={colors.primary} style={styles.spinner} />;
  if (isError) return <ErrorState onRetry={refetch} />;
  if (!data || data.items.length === 0) {
    return <Text style={styles.empty}>Вы ещё не создавали заказов — начните на вкладке «Создать».</Text>;
  }

  return (
    <FlatList
      data={data.items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => <MyOrderRow item={item} />}
    />
  );
}

function MyOrderRow({ item }: { item: MyOrderItem }) {
  const router = useRouter();
  return (
    <Pressable style={styles.myOrderRow} onPress={() => router.push({ pathname: "/order/[id]", params: { id: item.id } })}>
      <Text style={styles.myOrderTitle}>{item.normalizedTitle ?? "Обрабатывается…"}</Text>
      <View style={styles.myOrderFooter}>
        <Text style={styles.myOrderStatus}>{STATUS_LABELS[item.status]}</Text>
        {item.priceMinor != null && (
          <Text style={styles.myOrderPrice}>{(item.priceMinor / 100).toLocaleString("ru-RU")} ₽</Text>
        )}
      </View>
    </Pressable>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.error}>Не удалось загрузить список.</Text>
      <Pressable onPress={onRetry}>
        <Text style={styles.retry}>Повторить</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: spacing.lg },
  tabBar: { flexDirection: "row", paddingHorizontal: spacing.lg, gap: spacing.xs, marginBottom: spacing.md },
  segment: { flex: 1, paddingVertical: spacing.sm, borderRadius: radii.pill, backgroundColor: colors.surface, alignItems: "center" },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { ...typography.body, color: colors.textSecondary },
  segmentTextActive: { color: colors.textInverse, fontWeight: "600" },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  cardWrapper: { marginBottom: spacing.sm },
  empty: { ...typography.body, color: colors.textSecondary, paddingHorizontal: spacing.lg },
  spinner: { marginTop: spacing.lg },
  errorBox: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  myOrderRow: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.xs },
  myOrderTitle: { ...typography.subtitle, color: colors.textPrimary },
  myOrderFooter: { flexDirection: "row", justifyContent: "space-between" },
  myOrderStatus: { ...typography.caption, color: colors.textSecondary },
  myOrderPrice: { ...typography.caption, color: colors.textPrimary },
});
