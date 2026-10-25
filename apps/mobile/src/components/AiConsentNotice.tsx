import { Pressable, StyleSheet, Text } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getAiConsent } from "../api/consents";
import { colors, radii, spacing, typography } from "../theme/tokens";

/** Показывается, только если сервер требует согласие на ИИ-обработку, а действующего согласия нет. */
export function AiConsentNotice() {
  const { data } = useQuery({ queryKey: ["ai-consent"], queryFn: getAiConsent, staleTime: 60_000 });
  if (!data || data.kind === "not_required" || (data.kind === "required" && data.status === "granted")) return null;
  return (
    <Pressable style={styles.box} onPress={() => router.push("/ai-consent")} accessibilityRole="button">
      <Text style={styles.text}>
        {data.kind === "unavailable"
          ? "Обработка ИИ временно недоступна: профиль и заказы не обрабатываются."
          : "Нет согласия на обработку данных ИИ — профиль и заказы не обрабатываются. Нажмите, чтобы решить."}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderColor: colors.warning, borderRadius: radii.sm, padding: spacing.sm, marginBottom: spacing.sm },
  text: { ...typography.caption, color: colors.textPrimary },
});
