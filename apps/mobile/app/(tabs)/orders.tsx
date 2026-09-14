import { useState } from "react";
import { View, Text, TextInput, KeyboardAvoidingView, Platform, StyleSheet, FlatList, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HomeHeader } from "../../src/components/HomeHeader";
import { getFeed } from "../../src/api/feed";
import { getMyOrders, type MyOrderItem } from "../../src/api/my";
import type { OrderStatus } from "../../src/api/orders";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Черновик",
  processing: "Обрабатывается",
  processing_failed: "Ошибка обработки",
  moderation_hold: "На проверке",
  published: "Опубликован",
  negotiating: "Идут переговоры",
  closed: "Закрыт",
  expired: "Истёк",
  cancelled: "Отменён",
  rejected: "Отклонён",
};

/**
 * «Заказы» — то, что опубликовал сам пользователь (раздел 19/26 ТЗ, макет
 * Main.dc.html). GET /my/orders. Композер «Создать заказ» закреплён над
 * клавиатурой — переход в app/(tabs)/create.tsx с предзаполнением (раздел 6 ТЗ).
 * Только текст — голосовой ввод из композера и всего флоу создания заказа
 * убран по просьбе пользователя (было неочевидно, что запись — это ввод для
 * AI, а не голосовое сообщение, и путало). Второй из двух главных экранов
 * нижней навигации — см. app/(tabs)/index.tsx ("Возможности").
 */
export default function OrdersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["my-orders"], queryFn: () => getMyOrders() });
  const { data: feed } = useQuery({ queryKey: ["feed"], queryFn: () => getFeed() });

  const [needText, setNeedText] = useState("");
  const canContinue = needText.trim().length > 0;

  const handlePublish = () => {
    if (!canContinue) return;
    router.push({
      pathname: "/(tabs)/create",
      params: { prefillText: needText.trim() },
    });
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={[styles.headerPad, { paddingTop: insets.top + spacing.sm }]}>
            <HomeHeader active="orders" opportunitiesCount={feed?.items.length} ordersCount={data?.items.length} />
          </View>
        }
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
      <View style={[styles.composerDock, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Создать заказ"
            style={styles.input}
            value={needText}
            onChangeText={setNeedText}
            placeholder="Создать заказ"
            placeholderTextColor={colors.textSecondary}
            multiline
            autoCapitalize="sentences"
            textAlignVertical="center"
          />
          {canContinue && (
            <Pressable
              onPress={handlePublish}
              style={styles.sendButton}
              accessibilityRole="button"
              accessibilityLabel="Продолжить создание заказа"
            >
              <View accessible={false} style={styles.arrow}>
                <View style={styles.arrowStem} />
                <View style={styles.arrowHead} />
              </View>
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerPad: { marginBottom: spacing.md },
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
  myOrderPrice: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
  composerDock: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, backgroundColor: colors.background },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 58,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 29,
    paddingLeft: 20,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 2,
  },
  input: { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 144, paddingVertical: 11, paddingHorizontal: 0, fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  sendButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.textPrimary, alignItems: "center", justifyContent: "center" },
  arrow: { width: 22, height: 22, alignItems: "center" },
  arrowStem: { position: "absolute", top: 3, width: 2, height: 17, borderRadius: 1, backgroundColor: colors.textInverse },
  arrowHead: { position: "absolute", top: 3, width: 11, height: 11, borderTopWidth: 2, borderLeftWidth: 2, borderColor: colors.textInverse, transform: [{ rotate: "45deg" }] },
});
