import { View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MyResponsesList } from "../src/components/MyResponsesList";
import { colors, spacing, typography } from "../src/theme/tokens";

/**
 * «Мои отклики» — раздел 18/26 ТЗ. GET /my/responses. Строка ведёт на
 * общий экран заказа (app/order/[id].tsx) — там же живут раскрытие
 * контакта после выбора (#21), отзыв о завершённой работе (#25) и отзыв
 * своего отклика. С 2026-10-28 тот же список (src/components/MyResponsesList)
 * открывается и во вкладке «Заказы» → «Мои отклики»; маршрут /responses сохранён.
 */
export default function ResponsesScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Мои отклики</Text>
      <MyResponsesList />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  title: { ...typography.title, fontSize: 28, lineHeight: 34, color: colors.textPrimary, marginBottom: spacing.md, paddingHorizontal: spacing.lg },
});
