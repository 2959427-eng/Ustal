import { useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { myKeys, getMyOrders, getMyResponses } from "../src/api/my";
import type { OrderStatus } from "../src/api/orders";
import { colors, radii, spacing, typography } from "../src/theme/tokens";

const OUTCOME: Partial<Record<OrderStatus, string>> = {
  completed: "Выполнен",
  not_completed: "Не выполнен",
  closed: "Закрыт",
  expired: "Истёк",
  cancelled: "Отменён",
};

interface Row {
  key: string;
  orderId: string;
  title: string;
  outcome: string;
}

/**
 * Общий экран архива для обеих ролей — «Я исполнитель» (мои отклики) и
 * «Я заказчик» (мои заказы), переключаются табами ниже. Заказ/отклик
 * попадает сюда после оценки или пропуска, либо сразу, если он не
 * выполнен/закрыт.
 *
 * UX-правка: заголовок экрана зависит от выбранной роли, а не зашит как
 * всегда «Архив заказов» — со стороны исполнителя («Возможности») это
 * «История» (прошлые отклики — не «заказы», роль другая), со стороны
 * заказчика («Заказы») — «Архив заказов». Сам маршрут /archive и вся
 * логика загрузки/фильтрации данных общие, меняется только подпись.
 */
export default function ArchiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [role, setRole] = useState<"executor" | "customer">("executor");
  const orders = useQuery({ queryKey: myKeys.orders({ limit: 50 }), queryFn: () => getMyOrders({ limit: 50 }) });
  const responses = useQuery({ queryKey: myKeys.responses({ limit: 50 }), queryFn: () => getMyResponses({ limit: 50 }) });

  const rows: Row[] =
    role === "customer"
      ? (orders.data?.items ?? []).filter((o) => o.archived).map((o) => ({
          key: o.id, orderId: o.id, title: o.normalizedTitle ?? "Заказ", outcome: OUTCOME[o.status] ?? "",
        }))
      : (responses.data?.items ?? []).filter((r) => r.archived).map((r) => ({
          key: r.id,
          orderId: r.orderId,
          title: r.orderTitle ?? "Заказ",
          outcome:
            r.assignmentStatus === "completed" ? "Выполнено"
            : r.assignmentStatus === "not_completed" ? "Не выполнено"
            : r.status === "withdrawn" ? "Отклик отозван"
            : r.status === "not_selected" ? "Выбран другой исполнитель"
            : (r.orderStatus ? OUTCOME[r.orderStatus] ?? "" : ""),
        }));
  const loading = role === "customer" ? orders.isLoading : responses.isLoading;

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>{role === "executor" ? "История" : "Архив заказов"}</Text>
      <View style={styles.segments}>
        {(["executor", "customer"] as const).map((r) => (
          <Pressable key={r} style={[styles.segment, role === r && styles.segmentActive]} onPress={() => setRole(r)}>
            <Text style={[styles.segmentText, role === r && styles.segmentTextActive]}>
              {r === "executor" ? "Я исполнитель" : "Я заказчик"}
            </Text>
          </Pressable>
        ))}
      </View>
      {loading && <ActivityIndicator color={colors.primary} />}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xxl }}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>В архиве пока пусто.</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push({ pathname: "/order/[id]", params: { id: item.orderId, title: item.title } })}>
            <Text style={styles.rowTitle}>{item.title}</Text>
            {!!item.outcome && <Text style={styles.rowOutcome}>{item.outcome}</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  segments: { flexDirection: "row", gap: spacing.sm },
  segment: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: radii.button, backgroundColor: colors.surface },
  segmentActive: { backgroundColor: colors.textPrimary },
  segmentText: { ...typography.body, fontWeight: "700", color: colors.textPrimary },
  segmentTextActive: { color: colors.textInverse },
  empty: { ...typography.body, color: colors.textSecondary },
  row: { borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg, padding: spacing.md, gap: spacing.xs },
  rowTitle: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  rowOutcome: { ...typography.caption, color: colors.textTertiary },
});
