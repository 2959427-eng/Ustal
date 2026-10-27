import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { loadLegalDocument } from "../api/legal-document";
import { legalLinks, type LegalPage } from "../lib/legal-links";
import type { LegalDocumentView } from "../lib/legal-document";
import { PrimaryButton } from "./PrimaryButton";
import { colors, spacing, typography } from "../theme/tokens";

const fallbackTitle = (page: LegalPage) => legalLinks.find(([key]) => key === page)?.[1] ?? "Документ USTAL";

/**
 * Юридический документ поверх текущего экрана (без перехода в Safari/Chrome и без навигации):
 * экран под окном не размонтируется, поэтому введённые данные и состояние формы сохраняются.
 * Системная «Назад» на Android и жест закрытия — onRequestClose.
 */
export function LegalDocumentModal({ page, onClose }: { page: LegalPage | null; onClose: () => void }) {
  return (
    <Modal visible={page !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {page !== null && <DocumentContent key={page} page={page} onClose={onClose} />}
    </Modal>
  );
}

function DocumentContent({ page, onClose }: { page: LegalPage; onClose: () => void }) {
  const [doc, setDoc] = useState<LegalDocumentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setDoc(null); setFailed(false);
    loadLegalDocument(page, { signal: controller.signal }).then((d) => { if (active) setDoc(d); }, () => { if (active) setFailed(true); });
    return () => { active = false; controller.abort(); };
  }, [page, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.root} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={3}>{doc?.title ?? (page ? fallbackTitle(page) : "")}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть документ" hitSlop={12} style={styles.cross}>
              <Text style={styles.crossText}>✕</Text>
            </Pressable>
          </View>
          {doc ? (
            <ScrollView style={styles.body} contentContainerStyle={styles.content}>
              {doc.blocks.map((b, i) => (
                <Text key={i} selectable style={b.kind === "h2" ? styles.h2 : b.kind === "h3" ? styles.h3 : b.kind === "meta" ? styles.meta : styles.p}>
                  {b.kind === "li" ? `• ${b.text}` : b.text}
                </Text>
              ))}
            </ScrollView>
          ) : (
            <View style={[styles.body, styles.center]}>
              {failed ? (
                <>
                  <Text style={styles.p} accessibilityRole="alert">Не удалось загрузить документ. Проверьте подключение и повторите попытку.</Text>
                  <PrimaryButton label="Повторить" variant="secondary" onPress={retry} />
                </>
              ) : <ActivityIndicator accessibilityLabel="Загрузка документа" />}
            </View>
          )}
          <View style={styles.footer}><PrimaryButton label="Закрыть" onPress={onClose} /></View>
        </SafeAreaView>
      </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.textSecondary },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: colors.textPrimary },
  cross: { paddingHorizontal: spacing.xs },
  crossText: { fontSize: 22, color: colors.textPrimary },
  body: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  center: { justifyContent: "center", alignItems: "stretch", padding: spacing.lg, gap: spacing.md },
  h2: { fontSize: 18, fontWeight: "700", color: colors.textPrimary, marginTop: spacing.sm },
  h3: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  p: { ...typography.body, color: colors.textPrimary },
  meta: { ...typography.caption, color: colors.textSecondary },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
});
