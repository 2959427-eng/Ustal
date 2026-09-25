import { Pressable, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { colors, spacing, typography } from "../theme/tokens";

/**
 * Вход в общий экран app/archive.tsx (роль внутри экрана переключается
 * табами «Я исполнитель»/«Я заказчик», сам маршрут один для обеих ролей).
 * Подпись ссылки задаётся снаружи через `label`, потому что один и тот же
 * экран означает разное в зависимости от вкладки, с которой на него
 * переходят: со стороны «Заказы» (заказчик) это буквально «Архив заказов»
 * (значение по умолчанию); со стороны «Возможности» (исполнитель) экран
 * открывают под названием «История» (см. (tabs)/index.tsx) — чтобы не
 * называть прошлые отклики исполнителя «заказами» и не путать роли.
 */
export function ArchiveLink({ label = "Архив заказов →" }: { label?: string }) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push("/archive")} hitSlop={8} accessibilityRole="button" style={styles.link}>
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  text: { ...typography.body, fontWeight: "600", color: colors.primary },
});
