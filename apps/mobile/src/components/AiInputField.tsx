import { View, TextInput, Text, StyleSheet } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { VoiceRecorder } from "./VoiceRecorder";

interface Props {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  /** Записанное голосовое (локальный uri) — взаимоисключимо с текстом (раздел 8 ТЗ: "текст/голос"). */
  audioUri: string | null;
  onAudioRecorded: (uri: string) => void;
  onAudioDeleted: () => void;
  processing?: boolean;
}

/**
 * Базовый компонент: точка входа "Что вам нужно?" / "Что вы умеете делать?"
 * (раздел 6/9/27 ТЗ) — текст или запись голоса, не анкета с категориями.
 * Пока голос не записан — обычное текстовое поле с кнопкой записи в
 * футере; как только запись готова — поле ввода текста скрывается
 * (VoiceRecorder показывает прослушивание/удаление), а "Удалить" в
 * VoiceRecorder возвращает к текстовому вводу.
 */
export function AiInputField({
  value,
  onChangeText,
  placeholder,
  audioUri,
  onAudioRecorded,
  onAudioDeleted,
  processing,
}: Props) {
  return (
    <View style={styles.wrapper}>
      {!audioUri && (
        <TextInput
          style={styles.input}
          multiline
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          editable={!processing}
        />
      )}
      <View style={styles.footer}>
        <VoiceRecorder uri={audioUri} onRecorded={onAudioRecorded} onDelete={onAudioDeleted} disabled={processing} />
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
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.sm, gap: spacing.sm },
  processingLabel: { ...typography.caption, color: colors.textSecondary },
});
