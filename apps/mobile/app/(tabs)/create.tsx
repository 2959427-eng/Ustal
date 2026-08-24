import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { AiInputField } from "../../src/components/AiInputField";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography } from "../../src/theme/tokens";

/**
 * Создание заказа — текст/голос, дальше AI extraction, фото, цена,
 * контекстные чипы, предпросмотр, публикация (раздел 9/10 ТЗ, Фаза 3).
 * POST /orders с Idempotency-Key подключается вместе с extraction pipeline.
 */
export default function CreateOrderScreen() {
  const [text, setText] = useState("");

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Что вам нужно?</Text>
      <AiInputField
        value={text}
        onChangeText={setText}
        placeholder="Опишите, что нужно сделать — своими словами"
        onStartRecording={() => {}}
      />
      <PrimaryButton label="Продолжить" onPress={() => {}} disabled={text.trim().length === 0} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
});
