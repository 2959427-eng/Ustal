import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography } from "../../src/theme/tokens";

/** "Мои отклики" — раздел 26 ТЗ. GET /my/responses — Фаза 5. */
export default function ResponsesScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Мои отклики</Text>
      <Text style={styles.empty}>Вы ещё не откликались ни на один заказ.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  empty: { ...typography.body, color: colors.textSecondary },
});
