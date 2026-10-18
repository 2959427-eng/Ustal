import { View, Text, StyleSheet } from "react-native";
import type { Reputation } from "../api/reviews";
import { customerLine, executorLine } from "../lib/reputation-format";
import { colors, radii, spacing, typography } from "../theme/tokens";

/** Две отдельные репутации: как исполнитель и как заказчик. */
export function ReputationBlock({ reputation }: { reputation: Reputation }) {
  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Text style={styles.role}>Исполнитель</Text>
        <Text style={styles.line}>{executorLine(reputation.executor)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.role}>Заказчик</Text>
        <Text style={styles.line}>{customerLine(reputation.customer)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: "stretch", borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.lg, padding: spacing.md, gap: spacing.sm },
  row: { gap: 2 },
  role: { ...typography.caption, color: colors.textSecondary },
  line: { ...typography.body, fontWeight: "600", color: colors.textPrimary },
});
