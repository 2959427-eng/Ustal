import { View, TextInput, Text, StyleSheet, Pressable } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";

interface Props {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  onStartRecording: () => void;
  processing?: boolean;
}

/**
 * Базовый компонент: точка входа "Что вам нужно?" / "Что вы умеете делать?"
 * (раздел 6/9/27 ТЗ) — текст или запись голоса, не анкета с категориями.
 */
export function AiInputField({ value, onChangeText, placeholder, onStartRecording, processing }: Props) {
  return (
    <View style={styles.wrapper}>
      <TextInput
        style={styles.input}
        multiline
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        editable={!processing}
      />
      <View style={styles.footer}>
        <Pressable onPress={onStartRecording} disabled={processing} style={styles.recordButton} accessibilityRole="button">
          <Text style={styles.recordIcon}>●</Text>
        </Pressable>
        {processing && <Text style={styles.processingLabel}>AI обрабатывает…</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    minHeight: 120,
  },
  input: { ...typography.body, color: colors.textPrimary, minHeight: 72, textAlignVertical: "top" },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.sm },
  recordButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  recordIcon: { color: colors.textInverse, fontSize: 16 },
  processingLabel: { ...typography.caption, color: colors.textSecondary },
});
