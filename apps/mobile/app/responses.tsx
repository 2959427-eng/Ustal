import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { myKeys, getMyResponses, type MyResponseItem } from "../src/api/my";
import { responseStatusLabel } from "../src/lib/response-status";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/**
 * «Мои отклики» — раздел 18/26 ТЗ. GET /my/responses. Строка ведёт на
 * общий экран заказа (app/order/[id].tsx) — там же живут раскрытие
 * контакта после выбора (#21), отзыв о завершённой работе (#25) и отзыв
 * своего отклика; здесь — только список и короткая подсказка «оставить
 * отзыв» для уже завершённых, чтобы не дублировать всю логику формы отзыва
 * в двух местах.
 */
export default function ResponsesScreen() {
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: myKeys.responses(),
    queryFn: () => getMyResponses(),
  });

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Мои отклики</Text>

      {isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить отклики.</Text>
          <Pressable onPress={() => refetch()}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {data && data.items.length === 0 && <Text style={styles.empty}>Вы ещё не откликались ни на один заказ.</Text>}

      {data && data.items.length > 0 && (
        <FlatList
          data={data.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ResponseRow item={item} />}
        />
      )}
    </View>
  );
}

function ResponseRow({ item }: { item: MyResponseItem }) {
  const router = useRouter();
  return (
    <Pressable
      style={styles.row}
      onPress={() =>
        router.push({ pathname: "/order/[id]", params: { id: item.orderId, title: item.orderTitle ?? "" } })
      }
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
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  empty: { ...typography.body, color: colors.textSecondary },
  spinner: { marginTop: spacing.lg },
  errorBox: { gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  row: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.lg,
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
