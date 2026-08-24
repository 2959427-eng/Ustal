import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography } from "../../src/theme/tokens";

/**
 * Лента заказов (кандидату) / "Мои заказы" (автору) — раздел 15/26 ТЗ.
 * GET /feed и GET /my/orders подключаются в Фазе 4-5; здесь состояние empty.
 */
export default function OrdersScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Заказы</Text>
      <Text style={styles.empty}>Пока нет подходящих заказов — как только AI найдёт совпадение, вы увидите его здесь.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  empty: { ...typography.body, color: colors.textSecondary },
});
