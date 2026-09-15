import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getMyResponses, type MyResponseItem } from "../../src/api/my";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const STATUS_LABELS: Record<MyResponseItem["status"], string> = {
  active: "Ожидает решения",
  withdrawn: "Отозван",
  not_selected: "Не выбран",
};

/**
 * «Мои отклики» — раздел 18/26 ТЗ. GET /my/responses. Строка ведёт на
 * общий экран заказа (app/order/[id].tsx) — там же живут раскрытие
 * контакта после выбора (#21), отзыв о завершённой работе (#25) и отзыв
 * своего отклика; здесь — только список и короткая подсказка «оставить
 * отзыв» для уже завершённых, чтобы не дублировать всю логику формы отзыва
 * в двух местах.
 */
export default function ResponsesScreen() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["my-responses"],
    queryFn: () => getMyResponses(),
  });

  return (
    <View style={styles.container}>
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
  // Отмена заказа (в т.ч. после того, как исполнителя уже выбрали) переводит
  // отклик в тот же status="not_selected", что и обычное "не выбрали среди
  // прочих" — без этой проверки пользователь увидит одинаковую подпись для
  // двух разных по смыслу событий (UX-аудит, docs/evaluations/matching-ux-audit.md, MVP-правка 2).
  const statusLabel = item.assignmentStatus === "cancelled" ? "Заказ отменён" : STATUS_LABELS[item.status];
  return (
    <Pressable
      style={styles.row}
      onPress={() =>
        router.push({ pathname: "/order/[id]", params: { id: item.orderId, title: item.orderTitle ?? "" } })
      }
    >
      <Text style={styles.orderTitle}>{item.orderTitle ?? "Заказ обрабатывается"}</Text>
      <View style={styles.footer}>
        <Text style={styles.status}>{statusLabel}</Text>
        {item.offeredPriceMinor != null && (
          <Text style={styles.price}>{(item.offeredPriceMinor / 100).toLocaleString("ru-RU")} ₽</Text>
        )}
      </View>
      {item.isContactUnlocked && <Text style={styles.unlocked}>Контакты открыты</Text>}
      {item.assignmentStatus === "selected" && <Text style={styles.unlocked}>Вас выбрали</Text>}
      {item.assignmentStatus === "completed" && <Text style={styles.reviewHint}>Работа завершена — оставьте отзыв</Text>}
      {item.assignmentStatus === "not_completed" && <Text style={styles.error}>Отмечено как невыполненное</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
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
