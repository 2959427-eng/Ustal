import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getNotifications, markNotificationRead } from "../src/api/notifications";
import type { AppNotification } from "../src/api/notifications";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/**
 * Уведомления (раздел 26 ТЗ). GET /notifications — общий журнал внутри
 * приложения, не зависит от того, дошёл ли push (apps/api/src/lib/notify.ts).
 * `payload` в каждой записи уже содержит готовые title/body (их кладёт сам
 * сервер при создании — см. notifyUser() во всех местах, где он вызывается),
 * поэтому здесь не нужна карта «тип → текст»: она была бы лишним местом для
 * рассинхронизации с сервером.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications({ limit: 50 }),
  });

  const handlePress = async (item: AppNotification) => {
    if (!item.readAt) {
      void markNotificationRead(item.id).then(() => {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      });
    }
    const orderId = typeof item.payload.orderId === "string" ? item.payload.orderId : null;
    if (orderId) router.push({ pathname: "/order/[id]", params: { id: orderId } });
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Уведомления</Text>

      {isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить уведомления.</Text>
          <Pressable onPress={() => refetch()}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {data && data.items.length === 0 && <Text style={styles.empty}>Пока нет уведомлений.</Text>}

      {data && data.items.length > 0 && (
        <FlatList
          data={data.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const title = typeof item.payload.title === "string" ? item.payload.title : "Уведомление";
            const body = typeof item.payload.body === "string" ? item.payload.body : null;
            return (
              <Pressable style={styles.row} onPress={() => handlePress(item)}>
                <View style={styles.rowHeader}>
                  {!item.readAt && <View style={styles.dot} />}
                  <Text style={[styles.rowTitle, !item.readAt && styles.rowTitleUnread]}>{title}</Text>
                </View>
                {body && <Text style={styles.rowBody}>{body}</Text>}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  back: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: colors.primary },
  title: { ...typography.title, color: colors.textPrimary },
  spinner: { marginTop: spacing.lg },
  errorBox: { gap: spacing.xs },
  error: { ...typography.body, color: colors.danger },
  retry: { ...typography.body, color: colors.primary },
  empty: { ...typography.body, color: colors.textSecondary },
  row: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.xs },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.primary },
  rowTitle: { ...typography.body, color: colors.textSecondary },
  rowTitleUnread: { color: colors.textPrimary, fontWeight: "600" },
  rowBody: { ...typography.caption, color: colors.textSecondary },
});
