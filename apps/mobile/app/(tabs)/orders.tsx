import { useCallback, useState } from "react";
import { View, Text, KeyboardAvoidingView, Platform, StyleSheet, FlatList, Pressable, ActivityIndicator, Image, Alert } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { getMediaUrl } from "../../src/api/media";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SwipeToDelete } from "../../src/components/SwipeToDelete";
import { canDeleteOrder } from "../../src/lib/order-delete";
import { cancelOrder } from "../../src/api/orders";
import { OrdersQuickActions, QuickActionCard } from "../../src/components/QuickActions";
import { CreateOrderComposer } from "../../src/components/CreateOrderComposer";
import { MyResponsesList } from "../../src/components/MyResponsesList";
import { myKeys, getMyOrders, type MyOrderItem } from "../../src/api/my";
import type { OrderStatus } from "../../src/api/orders";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const STATUS_LABELS: Record<OrderStatus, string> = {
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

/**
 * «Заказы» (новый интерфейс 2026-10-28): вкладка нижней панели с двумя разделами.
 * «Мои заказы» — то, что опубликовал сам пользователь (GET /my/orders, раздел 19/26 ТЗ), «Архив заказов»
 * и поле «Создать заказ» (src/components/CreateOrderComposer — та же логика prefill, что была здесь).
 * «Мои отклики» — прежний экран откликов (src/components/MyResponsesList, GET /my/responses) и «История»
 * (app/archive.tsx?role=executor) — раньше были быстрыми карточками на «Возможностях».
 */
export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const [segment, setSegment] = useState<"orders" | "responses">("orders");
  const { data, isLoading, isError, isRefetching, refetch } = useQuery({ queryKey: myKeys.orders(), queryFn: () => getMyOrders() });
  useFocusEffect(useCallback(() => { void refetch(); }, [refetch]));

  // Архивные заказы (оценены/пропущены, не выполнены, закрыты) живут в «Архиве заказов».
  const activeOrders = (data?.items ?? []).filter((o) => o.status !== "cancelled" && !o.archived);

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.title} accessibilityRole="header">Заказы</Text>
        <View style={styles.segments} accessibilityRole="tablist">
          {([["orders", "Мои заказы"], ["responses", "Мои отклики"]] as const).map(([key, label]) => (
            <Pressable
              key={key}
              style={[styles.segment, segment === key && styles.segmentActive]}
              onPress={() => setSegment(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: segment === key }}
            >
              <Text style={[styles.segmentText, segment === key && styles.segmentTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {segment === "orders" ? (
        <FlatList
          refreshing={isRefetching}
          onRefresh={() => { void refetch(); }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          data={activeOrders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={<View style={styles.linksRow}><OrdersQuickActions /></View>}
          ListEmptyComponent={
            isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.spinner} />
            ) : isError ? (
              <View style={styles.errorBox}>
                <Text style={styles.error}>Не удалось загрузить список.</Text>
                <Pressable onPress={() => refetch()}>
                  <Text style={styles.retry}>Повторить</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.empty}>Вы ещё не создавали заказов — опишите, что нужно, ниже.</Text>
            )
          }
          renderItem={({ item }) => <MyOrderRow item={item} />}
        />
      ) : (
        <MyResponsesList
          header={<View style={styles.linksRow}><QuickActionCard icon="time-outline" title="История" subtitle="Заказы, которые я выполнял" href={{ pathname: "/archive", params: { role: "executor" } }} /></View>}
        />
      )}
      <CreateOrderComposer bottomInset={false} />
    </KeyboardAvoidingView>
  );
}

function MyOrderRow({ item }: { item: MyOrderItem }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const confirmDelete = () => {
    Alert.alert("Удалить заказ?", "Заказ пропадёт из ленты исполнителей и из вашего списка.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: async () => {
          try {
            await cancelOrder(item.id);
            void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
          } catch (err) {
            Alert.alert("Не удалось удалить заказ", err instanceof Error ? err.message : "Попробуйте ещё раз.");
          }
        },
      },
    ]);
  };

  return (
    <SwipeToDelete enabled={canDeleteOrder(item.status)} onDelete={confirmDelete}>
    <Pressable style={[styles.myOrderRow, { marginBottom: 0 }]} onPress={() => router.push({ pathname: "/order/[id]", params: { id: item.id } })}>
      <Text style={styles.myOrderTitle}>{item.normalizedTitle ?? (item.status === "processing_failed" ? "Не удалось обработать заказ" : "Обрабатывается…")}</Text>
      {!!item.photoMediaIds?.length && <View style={styles.photoRow}>
        {item.photoMediaIds.slice(0, 4).map((id) => <Image key={id} source={{ uri: getMediaUrl(id) }} style={styles.photo} accessibilityLabel="Фото заказа" />)}
      </View>}
      <View style={styles.myOrderFooter}>
        <Text style={item.ratingPending ? styles.myOrderStatusPending : styles.myOrderStatus}>
          {item.ratingPending ? "Оценить" : STATUS_LABELS[item.status]}
          {!!item.activeResponsesCount && ` · откликов: ${item.activeResponsesCount}`}
        </Text>
        {item.priceMinor != null && (
          <Text style={styles.myOrderPrice}>{(item.priceMinor / 100).toLocaleString("ru-RU")} ₽</Text>
        )}
      </View>
    </Pressable>
    </SwipeToDelete>
  );
}

const styles = StyleSheet.create({
  photoRow: { flexDirection: "row", gap: spacing.xs },
  photo: { width: 64, height: 64, borderRadius: radii.md },
  container: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5, color: colors.textPrimary, marginBottom: spacing.md },
  segments: { flexDirection: "row", backgroundColor: colors.surfaceAlt, borderRadius: radii.md, padding: 2 },
  segment: { flex: 1, minHeight: 40, borderRadius: radii.sm, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: colors.background, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segmentText: { ...typography.body, fontWeight: "500", color: colors.textSecondary },
  segmentTextActive: { color: colors.textPrimary, fontWeight: "600" },
  linksRow: { marginTop: spacing.md, marginBottom: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  empty: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.sm },
  spinner: { marginTop: spacing.lg, marginBottom: spacing.md },
  errorBox: { gap: spacing.xs, marginBottom: spacing.md },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  myOrderRow: {
    backgroundColor: colors.background,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  myOrderTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  myOrderFooter: { flexDirection: "row", justifyContent: "space-between" },
  myOrderStatus: { ...typography.caption, color: colors.textTertiary },
  myOrderStatusPending: { ...typography.caption, fontWeight: "700", color: colors.primary },
  myOrderPrice: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
});
