import { useCallback, useState } from "react";
import { View, TextInput, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formDraftSession, readFormDraft, useOnSessionChange, writeFormDraft } from "../lib/form-drafts";
import { colors, spacing } from "../theme/tokens";

/**
 * Поле «Создать заказ» — вынесено без изменений логики из app/(tabs)/orders.tsx (новый интерфейс 2026-10-28),
 * чтобы то же поле стояло и на «Главной» («Что вам нужно сделать?»). Только текст, без голосового ввода.
 * Текст передаётся на экран создания заказа (prefill) и в черновик заказа — как раньше.
 */
export function CreateOrderComposer({ placeholder = "Создать заказ", bottomInset = true }: { placeholder?: string; bottomInset?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [needText, setNeedText] = useState("");
  const canContinue = needText.trim().length > 0;
  // Вкладка остаётся примонтированной: текст композера прежнего пользователя не переходит к следующему.
  useOnSessionChange(useCallback(() => setNeedText(""), []));

  const handlePublish = () => {
    if (!canContinue) return;
    const draftSession = formDraftSession();
    const current = readFormDraft("order", draftSession);
    // Начатый на экране заказа черновик не перезаписываем (как и раньше: prefill — только в пустую форму).
    if (!current?.text.trim()) writeFormDraft("order", { text: needText.trim(), priceText: current?.priceText ?? "", acceptsPriceOffers: current?.acceptsPriceOffers ?? false, photos: current?.photos ?? [] }, draftSession);
    router.push({
      pathname: "/(tabs)/create",
      params: { prefillText: needText.trim(), prefillSession: formDraftSession().id ?? "" },
    });
    setNeedText("");
  };

  return (
    <View style={[styles.composerDock, { paddingBottom: bottomInset ? Math.max(insets.bottom, spacing.sm) : spacing.sm }]}>
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel={placeholder}
          style={styles.input}
          value={needText}
          onChangeText={setNeedText}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          multiline
          autoCapitalize="sentences"
          textAlignVertical="center"
        />
        {canContinue && (
          <Pressable onPress={handlePublish} style={styles.sendButton} accessibilityRole="button" accessibilityLabel="Продолжить создание заказа">
            <View accessible={false} style={styles.arrow}>
              <View style={styles.arrowStem} />
              <View style={styles.arrowHead} />
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composerDock: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 26,
    paddingLeft: 18,
    paddingRight: 4,
    paddingVertical: 4,
    gap: 2,
  },
  input: { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 144, paddingVertical: 11, paddingHorizontal: 0, fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  sendButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  arrow: { width: 22, height: 22, alignItems: "center" },
  arrowStem: { position: "absolute", top: 3, width: 2, height: 17, borderRadius: 1, backgroundColor: colors.textInverse },
  arrowHead: { position: "absolute", top: 3, width: 11, height: 11, borderTopWidth: 2, borderLeftWidth: 2, borderColor: colors.textInverse, transform: [{ rotate: "45deg" }] },
});
