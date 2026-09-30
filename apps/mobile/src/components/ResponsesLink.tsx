import { Pressable, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { colors, spacing, typography } from "../theme/tokens";

/**
 * Вход в «Мои отклики» (app/(tabs)/responses.tsx). До 2026-09-22 экран
 * существовал в коде, но был физически недостижим: `href: null` в
 * (tabs)/_layout.tsx убирает его из нижнего бара (ожидаемо, макет с двумя
 * вкладками), но ни одной ссылки на него больше нигде не было — см.
 * claude/ux-journey-audit-2026-09-22.md, «Важно» №2.
 *
 * 2026-09-23 fix: «Мои отклики» — это про исполнителя, поэтому ссылка живёт
 * на «Возможности» (app/(tabs)/index.tsx), рядом с ArchiveLink (там же
 * подписан «История» — см. его комментарий); раньше по ошибке стояла на
 * «Заказы» (роль заказчика), что путало роли.
 */
export function ResponsesLink() {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push("/responses")} hitSlop={8} accessibilityRole="button" style={styles.link}>
      <Text style={styles.text}>Мои отклики →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  text: { ...typography.body, fontWeight: "600", color: colors.primary },
});
