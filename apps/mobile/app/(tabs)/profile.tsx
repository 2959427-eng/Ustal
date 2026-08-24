import { View, Text, StyleSheet } from "react-native";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography } from "../../src/theme/tokens";

/**
 * Профиль: AI-профиль возможностей (создание/редактирование — Фаза 2),
 * настройки, заблокированные пользователи (раздел 26 ТЗ).
 */
export default function ProfileScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Профиль</Text>
      <Text style={styles.body}>
        Расскажите голосом или текстом, что вы умеете, какие у вас инструменты,
        транспорт или другие ресурсы — AI соберёт из этого профиль возможностей.
      </Text>
      <PrimaryButton label="Создать AI-профиль" onPress={() => {}} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
});
