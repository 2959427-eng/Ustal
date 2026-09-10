import { useState } from "react";
import { View, Text, TextInput, Pressable, Modal, StyleSheet } from "react-native";
import { submitReport } from "../api/reports";
import type { ReportTargetType } from "../api/reports";
import { PrimaryButton } from "./PrimaryButton";
import { colors, radii, spacing, typography } from "../theme/tokens";

const REASONS = ["Спам", "Мошенничество", "Оскорбления", "Не соответствует описанию", "Другое"];

interface Props {
  visible: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: string;
}

/**
 * Жалоба (раздел 28 ТЗ) — на заказ, пользователя или отклик (`POST
 * /reports`, apps/api/src/routes/reports.ts). Не отдельный экран/таб (в
 * навигации из screens.md его нет), а модалка, вызываемая контекстно —
 * из карточки заказа, кандидата или отклика (см. app/order/[id].tsx).
 * `reason` на сервере — свободная строка (max 100), не enum: список ниже
 * задаёт типовые причины только на клиенте.
 */
export function ReportModal({ visible, onClose, targetType, targetId }: Props) {
  const [reason, setReason] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => {
    setReason(null);
    setComment("");
    setError(null);
    setDone(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!reason) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitReport({ targetType, targetId, reason, comment: comment.trim() || undefined });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить жалобу.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {done ? (
            <>
              <Text style={styles.title}>Жалоба отправлена</Text>
              <Text style={styles.body}>Спасибо, мы её рассмотрим.</Text>
              <PrimaryButton label="Закрыть" onPress={handleClose} />
            </>
          ) : (
            <>
              <Text style={styles.title}>Пожаловаться</Text>
              <View style={styles.reasonList}>
                {REASONS.map((r) => (
                  <Pressable
                    key={r}
                    style={[styles.reasonChip, reason === r && styles.reasonChipActive]}
                    onPress={() => setReason(r)}
                  >
                    <Text style={[styles.reasonText, reason === r && styles.reasonTextActive]}>{r}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={styles.textArea}
                value={comment}
                onChangeText={setComment}
                placeholder="Комментарий (необязательно)"
                multiline
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <PrimaryButton label="Отправить жалобу" onPress={handleSubmit} loading={submitting} disabled={!reason} />
              <PrimaryButton label="Отмена" variant="secondary" onPress={handleClose} disabled={submitting} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg, padding: spacing.lg, gap: spacing.sm },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
  reasonList: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  reasonChip: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  reasonChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  reasonText: { ...typography.caption, color: colors.textPrimary },
  reasonTextActive: { color: colors.textInverse },
  textArea: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
    minHeight: 64,
    textAlignVertical: "top",
  },
  error: { ...typography.caption, color: colors.danger },
});
