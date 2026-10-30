import type { ReactElement } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { myKeys, getMyResponses, type MyResponseItem } from "../api/my";
import { responseStatusLabel } from "../lib/response-status";
import { colors, spacing, typography } from "../theme/tokens";

/**
 * Список «Мои отклики» — вынесен без изменений логики из app/responses.tsx (новый интерфейс 2026-10-28):
 * тот же GET /my/responses, те же статусы и строки. Используется экраном app/responses.tsx и разделом
 * «Мои отклики» вкладки «Заказы». Строка ведёт на общий экран заказа app/order/[id].tsx.
 */
export function MyResponsesList({ header, footer }: { header?: ReactElement; footer?: ReactElement }) {
  const { data, isLoading, isError, isRefetching, refetch } = useQuery({
    queryKey: myKeys.responses(),
    queryFn: () => getMyResponses(),
  });

  return (
    <FlatList
      data={data?.items ?? []}
      keyExtractor={(item) => item.id}
      refreshing={isRefetching}
      onRefresh={() => { void refetch(); }}
      contentContainerStyle={styles.list}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={
        isLoading ? (
          <ActivityIndicator color={colors.primary} style={styles.spinner} />
        ) : isError ? (
          <View style={styles.errorBox}>
            <Text style={styles.error}>Не удалось загрузить отклики.</Text>
            <Pressable onPress={() => refetch()}>
              <Text style={styles.retry}>Повторить</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.empty}>Вы ещё не откликались ни на один заказ.</Text>
        )
      }
      renderItem={({ item }) => <ResponseRow item={item} />}
    />
  );
}

function ResponseRow({ item }: { item: MyResponseItem }) {
  const router = useRouter();
  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push({ pathname: "/order/[id]", params: { id: item.orderId, title: item.orderTitle ?? "" } })}
    >
      <Text style={styles.orderTitle}>{item.orderTitle ?? "Заказ обрабатывается"}</Text>
      <View style={styles.footer}>
        <Text style={styles.status}>{responseStatusLabel(item.status, item.orderStatus, item.assignmentStatus)}</Text>
        {item.offeredPriceMinor != null && (
          <Text style={styles.price}>{(item.offeredPriceMinor / 100).toLocaleString("ru-RU")} ₽</Text>
        )}
      </View>
      {item.isContactUnlocked && <Text style={styles.unlocked}>Контакты открыты</Text>}
      {item.assignmentStatus === "selected" && <Text style={styles.unlocked}>Идут переговоры</Text>}
      {item.assignmentStatus === "in_progress" && <Text style={styles.unlocked}>В работе</Text>}
      {item.assignmentStatus === "completed" && <Text style={styles.reviewHint}>Работа завершена — оставьте отзыв</Text>}
      {item.assignmentStatus === "not_completed" && <Text style={styles.error}>Отмечено как невыполненное</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  empty: { ...typography.body, color: colors.textSecondary },
  spinner: { marginTop: spacing.lg },
  errorBox: { gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  row: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  orderTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  footer: { flexDirection: "row", justifyContent: "space-between" },
  status: { ...typography.caption, color: colors.textTertiary },
  price: { ...typography.caption, fontWeight: "700", color: colors.textPrimary },
  unlocked: { ...typography.caption, fontWeight: "600", color: colors.success },
  reviewHint: { ...typography.caption, fontWeight: "600", color: colors.primary },
});
