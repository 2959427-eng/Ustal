import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { legalLinks, type LegalPage } from "../lib/legal-links";
import { LegalDocumentModal } from "./LegalDocumentModal";

/** Ссылки на юридические документы: открываются во встроенном окне поверх экрана (LegalDocumentModal). */
export function LegalLinks() {
  const [open, setOpen] = useState<LegalPage | null>(null);
  return <View style={{ gap: 12, paddingVertical: 16 }}>
    {legalLinks.map(([page, label]) => <Pressable key={page} accessibilityRole="link" onPress={() => setOpen(page)}><Text style={{ color: "#075c8c", textDecorationLine: "underline" }}>{label}</Text></Pressable>)}
    <LegalDocumentModal page={open} onClose={() => setOpen(null)} />
  </View>;
}

/** Одна ссылка на документ — для отметок регистрации и окна согласия. */
export function LegalLink({ page, label }: { page: LegalPage; label: string }) {
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable accessibilityRole="link" onPress={() => setOpen(true)}><Text style={{ color: "#075c8c", textDecorationLine: "underline" }}>{label}</Text></Pressable>
    <LegalDocumentModal page={open ? page : null} onClose={() => setOpen(false)} />
  </View>;
}
