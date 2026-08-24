import { Pressable, Text, StyleSheet, ActivityIndicator, GestureResponderEvent } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";

interface Props {
  label: string;
  onPress: (e: GestureResponderEvent) => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}

/** Базовый компонент прототипа (раздел 27 ТЗ). */
export function PrimaryButton({ label, onPress, loading, disabled, variant = "primary" }: Props) {
  const isSecondary = variant === "secondary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        isSecondary ? styles.secondary : styles.primary,
        (disabled || loading) && styles.disabled,
        pressed && !disabled && !loading && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
    >
      {loading ? (
        <ActivityIndicator color={isSecondary ? colors.primary : colors.textInverse} />
      ) : (
        <Text style={[styles.label, isSecondary && styles.labelSecondary]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  label: { ...typography.subtitle, color: colors.textInverse },
  labelSecondary: { color: colors.textPrimary },
});
