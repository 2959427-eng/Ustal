import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";

/** Отметка согласия: по умолчанию не отмечена, меняется только нажатием пользователя. */
export function ConsentCheckbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        hitSlop={8}
        style={[styles.box, checked && styles.boxChecked]}
      >
        {checked ? <Text style={styles.tick}>✓</Text> : null}
      </Pressable>
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.sm },
  box: { width: 22, height: 22, borderRadius: radii.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: "#fff", fontSize: 14, lineHeight: 16 },
  text: { ...typography.caption, color: colors.textPrimary, flex: 1 },
});
