import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { blockUser } from "../api/blocks";
import { ReportModal } from "./ReportModal";
import { colors, spacing, typography } from "../theme/tokens";
/** Раздел 28/29 ТЗ: жалоба и блокировка конкретного человека — контекстные действия, не отдельный экран. */
export function ReportAndBlockRow({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [reportOpen, setReportOpen] = useState(false);
  const inFlight = useRef(false);
  const submitting = useRef(false);
  const [blocking, setBlocking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  const handleBlock = () => {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    Alert.alert("Заблокировать пользователя?", "Контакты, новые отклики и переговоры будут закрыты. Назначенные заказы в работе и завершённые останутся доступны.", [
      { text: "Отмена", style: "cancel", onPress: () => { inFlight.current = false; } },
      {
        text: "Заблокировать",
        style: "destructive",
        onPress: async () => {
          if (submitting.current || blocked) return;
          submitting.current = true;
          setBlocking(true);
          setBlockError(null);
          try {
            await blockUser(userId);
            setBlocked(true);
            // Только данные, которые меняет блокировка (F04): кандидаты и карточки заказов, отклики,
            // лента и список заблокированных. Без глобального сброса кэша.
            for (const queryKey of [["order-candidates"], ["order"], ["order-view"], ["my-responses"], ["feed"], ["blocks"]])
              void queryClient.invalidateQueries({ queryKey });
          } catch (err) {
            // Ошибка не выглядит как успех: явное сообщение, состояние не меняется, можно повторить (F03).
            setBlockError(`Не удалось заблокировать пользователя. ${err instanceof Error ? err.message : ""}`.trim());
          } finally {
            submitting.current = false;
            inFlight.current = false;
            setBlocking(false);
          }
        },
      },
    ], { cancelable: false });
  };

  return (
    <View style={styles.rowActions}>
      <Pressable accessibilityRole="button" onPress={() => setReportOpen(true)} hitSlop={6}>
        <Text style={styles.mutedLink}>Пожаловаться</Text>
      </Pressable>
      {blocked ? (
        <Text style={styles.mutedLink}>Пользователь заблокирован</Text>
      ) : (
        <Pressable accessibilityRole="button" onPress={handleBlock} hitSlop={6} disabled={blocking}>
          <Text style={styles.mutedLink}>{blocking ? "Блокируем…" : "Заблокировать"}</Text>
        </Pressable>
      )}
      {blockError && <Text style={styles.error}>{blockError}</Text>}
      <ReportModal visible={reportOpen} onClose={() => setReportOpen(false)} targetType="user" targetId={userId} />
    </View>
  );
}

const styles = StyleSheet.create({
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  mutedLink: { ...typography.caption, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
});
