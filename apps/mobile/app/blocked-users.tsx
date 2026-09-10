import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBlocks, unblockUser } from "../src/api/blocks";
import type { BlockedUser } from "../src/api/blocks";
import { colors, spacing, typography, radii } from "../src/theme/tokens";

/** Заблокированные пользователи (раздел 29 ТЗ). GET/DELETE /blocks. */
export default function BlockedUsersScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["blocks"],
    queryFn: getBlocks,
  });

  const handleUnblock = (item: BlockedUser) => {
    Alert.alert("Разблокировать?", item.blockedName ?? undefined, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Разблокировать",
        onPress: async () => {
          try {
            await unblockUser(item.id);
            void queryClient.invalidateQueries({ queryKey: ["blocks"] });
          } catch {
            // Ничего критичного — строка просто останется в списке, можно повторить.
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.backText}>← Назад</Text>
      </Pressable>
      <Text style={styles.title}>Заблокированные пользователи</Text>

      {isLoading && <ActivityIndicator color={colors.primary} style={styles.spinner} />}

      {isError && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>Не удалось загрузить список.</Text>
          <Pressable onPress={() => refetch()}>
            <Text style={styles.retry}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {data && data.items.length === 0 && <Text style={styles.empty}>Заблокированных пользователей нет.</Text>}

      {data && data.items.length > 0 && (
        <FlatList
          data={data.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowName}>{item.blockedName ?? "Пользователь"}</Text>
              <Pressable onPress={() => handleUnblock(item)} hitSlop={8}>
                <Text style={styles.retry}>Разблокировать</Text>
              </Pressable>
            </View>
          )}
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
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowName: { ...typography.body, color: colors.textPrimary },
});
