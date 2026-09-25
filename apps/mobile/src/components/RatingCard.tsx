import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { getOrderRating, rateOrder } from "../api/reviews";
import { PrimaryButton } from "./PrimaryButton";
import { colors, radii, spacing, typography } from "../theme/tokens";

/**
 * «Оценить»: после выполненного заказа обе стороны ставят друг другу 1–5 —
 * кнопка «Пропустить» убрана по просьбе пользователя, оценка обязательна.
 * Общая карточка для обеих сторон: сервер сам решает, есть ли что оценить
 * (pending) и кого — targetRole (см. apps/api/src/routes/reviews.ts). Без
 * текста. После оценки заказ/отклик уходит в архив своей стороны.
 */
export function RatingCard({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ["order-rating", orderId], queryFn: () => getOrderRating(orderId), retry: false });
  const [rating, setRating] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!q.data?.pending) return null;
  const title = q.data.targetRole === "customer" ? "Оцените заказчика" : "Оцените исполнителя";

  const submit = async (value: number | null) => {
    setError(null);
    setBusy(true);
    try {
      await rateOrder(orderId, value);
      void queryClient.invalidateQueries({ queryKey: ["order-rating", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["my-responses"] });
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      router.back(); // заказ ушёл в архив
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить оценку.");
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setRating(n)} hitSlop={6} accessibilityLabel={`Оценка ${n}`}>
            <Text style={[styles.star, n <= rating && styles.starActive]}>★</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton label="Оценить" onPress={() => void submit(rating)} loading={busy} disabled={rating === 0} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: colors.primary, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  title: { ...typography.subtitle, fontWeight: "700", color: colors.textPrimary },
  stars: { flexDirection: "row", gap: spacing.sm, justifyContent: "center" },
  star: { fontSize: 36, color: colors.border },
  starActive: { color: "#F5A623" },
  error: { ...typography.body, color: colors.danger },
});
