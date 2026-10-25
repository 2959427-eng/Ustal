import { useCallback, useRef, useState } from "react";
import { ScrollView, Text, Linking } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { getConsents, changeConsent } from "../src/api/consents";
import type { ConsentSnapshot } from "../src/lib/ai-consent";
import { PrimaryButton } from "../src/components/PrimaryButton";
export default function AiConsentScreen() {
  const [snapshot, setSnapshot] = useState<ConsentSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const load = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setSnapshot(null); setError("");
    try { setSnapshot(await getConsents()); }
    catch { setError("Настройки AI недоступны. Разрешение не изменено. При текущей версии сервера этот экран не гарантирует остановку AI. Для прекращения передачи не отправляйте новые тексты или голос; обратитесь в support@ustal.site."); }
    finally { lock.current = false; setBusy(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => setSnapshot(null); }, [load]));
  const decide = async (purpose: string, decision: "grant" | "revoke") => {
    if (!snapshot || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await changeConsent(snapshot, purpose, decision); setSnapshot(await getConsents()); }
    catch { setSnapshot(null); setError("Изменение не подтверждено. Обновите экран и проверьте состояние разрешения."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
    <Text accessibilityRole="header">Передача данных AI</Text>
    <Text>OpenAI получает данные через relay USTAL. Разрешение не выдаётся фактом регистрации или открытием этого экрана.</Text>
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    {snapshot && !snapshot.outboundEnforcement ? <Text>Контроль согласия сервером выключен. Этот экран пока не управляет передачей AI. Не отправляйте новые данные, если не хотите их обработки.</Text> : null}
    {snapshot?.outboundEnforcement && !snapshot.policies.some(p => p.purpose === snapshot.aiConsentPurpose) ? <Text>Утверждённые условия пока недоступны.</Text> : null}
    {snapshot?.policies.filter(p => p.purpose === snapshot.aiConsentPurpose).map(p => <ScrollView key={p.id}>
      <Text>{p.purpose} — версия {p.version}</Text>
      <Text>{p.content.humanText || "Текст условий недоступен"}</Text>
      <Text>{snapshot.decisions.some(d => d.purpose === p.purpose && d.effective) ? "Разрешение действует" : "Действующего разрешения нет"}</Text>
      <PrimaryButton label="Разрешить передачу" disabled={!snapshot.outboundEnforcement || p.status !== "approved" || busy} onPress={() => void decide(p.purpose, "grant")} />
    </ScrollView>)}
    {snapshot?.decisions.filter(d => d.decision === "grant").map(d => <PrimaryButton key={d.purpose} label={`Отозвать разрешение: ${d.purpose}`} disabled={busy} variant="secondary" onPress={() => void decide(d.purpose, "revoke")} />)}
    <Text>Если контроль выключен, отзыв записывается, но не гарантирует остановку AI. При действующем контроле отказ приостанавливает новые AI-операции. Отзыв не отменяет уже отправленный запрос. Непроверенный контент не должен публиковаться в обход модерации.</Text>
    <PrimaryButton label="Продолжить без нового разрешения" variant="secondary" disabled={busy} onPress={() => router.back()} />
    <Text onPress={() => void Linking.openURL("https://ustal.site/privacy")}>Privacy Policy</Text>
    <PrimaryButton label="Обновить состояние" loading={busy} onPress={() => void load()} />
  </ScrollView>;
}
