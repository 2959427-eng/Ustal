import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AiInputField } from "../../src/components/AiInputField";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";
import { logout } from "../../src/api/auth";
import {
  getProfile,
  submitProfileInput,
  getProfileInput,
  editProfileTranscript,
  confirmProfileInput,
  getProfileDraft,
  applyProfileDraft,
  discardProfileDraft,
} from "../../src/api/profile";
import { uploadMedia } from "../../src/api/media";
import { generateIdempotencyKey } from "../../src/lib/idempotency-key";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 45000;

type Phase = "idle" | "transcribing" | "transcript_review" | "processing" | "draft_review";

/**
 * Профиль: AI-профиль возможностей (раздел 7 ТЗ — текст и голос, см.
 * src/components/VoiceRecorder.tsx), ссылки на уведомления (раздел 26 ТЗ,
 * app/notifications.tsx) и настройки (раздел 27 ТЗ, app/settings.tsx —
 * оттуда же ссылка на заблокированных пользователей, раздел 29 ТЗ).
 * Logout — реальный.
 *
 * Две паузы AI-пайплайна (claude/pipeline-split-design.md, backend-срез
 * «разделить STT/extraction пайплайн»):
 *
 * Экран 9 «Проверка транскрипции» — voice-ввод сначала уходит только на
 * STT (`phase="transcribing"`, поллинг GET /profile/inputs/{id}), затем
 * пользователь видит и может поправить распознанный текст
 * (`phase="transcript_review"`, PATCH .../inputs/{id}) и только явно
 * подтверждает отправку в AI (POST .../confirm). Text-ввод эту паузу не
 * проходит — правка уже произошла в композере до отправки.
 *
 * Экран 10 «...подтверждения удаления значимых пунктов» — extraction
 * создаёт ЧЕРНОВИК (`phase="processing"` → поллинг GET /profile/draft),
 * который показывается пользователю С ДИФФОМ (что добавится/уберётся)
 * ДО применения (`phase="draft_review"`) — пользователь явно применяет
 * (POST /profile/draft/{id}/apply) или отклоняет (POST .../discard).
 * `GET /profile` (ниже) отдаёт только уже применённую версию. Это
 * заменяет прежний временный компромисс (постфактум-сверку из slice 7
 * этой ветки) полноценной блокирующей паузой.
 */
export default function ProfileScreen() {
  const queryClient = useQueryClient();
  const [loggingOut, setLoggingOut] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState("");
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [sourceInputId, setSourceInputId] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const originalTranscriptRef = useRef("");

  const pollDeadlineRef = useRef<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });

  const inputQuery = useQuery({
    queryKey: ["profileInput", sourceInputId],
    queryFn: () => getProfileInput(sourceInputId!),
    enabled: phase === "transcribing" && !!sourceInputId,
    refetchInterval: phase === "transcribing" ? POLL_INTERVAL_MS : false,
  });

  const draftQuery = useQuery({
    queryKey: ["profileDraft"],
    queryFn: getProfileDraft,
    enabled: phase === "processing",
    refetchInterval: phase === "processing" ? POLL_INTERVAL_MS : false,
  });

  // Транскрипция готова — переходим к её проверке.
  useEffect(() => {
    if (phase !== "transcribing" || !inputQuery.data) return;
    if (inputQuery.data.status === "awaiting_review") {
      const t = inputQuery.data.transcript ?? "";
      originalTranscriptRef.current = t;
      setTranscriptText(t);
      setPollTimedOut(false);
      pollDeadlineRef.current = null;
      setPhase("transcript_review");
    } else if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
      setPollTimedOut(true);
    }
  }, [inputQuery.data, phase]);

  // Черновик после extraction готов — показываем дифф на подтверждение.
  useEffect(() => {
    if (phase !== "processing" || !draftQuery.data) return;
    if (draftQuery.data.draft) {
      setPollTimedOut(false);
      pollDeadlineRef.current = null;
      setPhase("draft_review");
    } else if (pollDeadlineRef.current && Date.now() > pollDeadlineRef.current) {
      setPollTimedOut(true);
    }
  }, [draftQuery.data, phase]);

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      router.replace("/onboarding");
    } finally {
      setLoggingOut(false);
    }
  };

  const startDraftPolling = () => {
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    setPollTimedOut(false);
    setPhase("processing");
  };

  const onSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed && !audioUri) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const idempotencyKey = generateIdempotencyKey("profile-input");
      if (audioUri) {
        const { mediaId } = await uploadMedia("audio", { uri: audioUri, name: "voice.m4a", type: "audio/m4a" });
        const accepted = await submitProfileInput({ inputType: "voice", audioMediaId: mediaId }, idempotencyKey);
        setSourceInputId(accepted.sourceInputId);
        pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
        setPollTimedOut(false);
        setPhase("transcribing");
      } else {
        await submitProfileInput({ inputType: "text", text: trimmed }, idempotencyKey);
        startDraftPolling();
      }
      setComposerOpen(false);
      setText("");
      setAudioUri(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось отправить. Попробуйте ещё раз.");
    } finally {
      setSubmitting(false);
    }
  };

  const onConfirmTranscript = async () => {
    if (!sourceInputId) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (transcriptText.trim() !== originalTranscriptRef.current) {
        await editProfileTranscript(sourceInputId, transcriptText.trim());
      }
      const idempotencyKey = generateIdempotencyKey("profile-confirm-transcript");
      await confirmProfileInput(sourceInputId, idempotencyKey);
      startDraftPolling();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось подтвердить транскрипт.");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelAll = () => {
    setPhase("idle");
    setSourceInputId(null);
    setSubmitError(null);
    setPollTimedOut(false);
    pollDeadlineRef.current = null;
  };

  const draft = phase === "draft_review" ? draftQuery.data : null;

  const onApplyDraft = async () => {
    if (!draft?.draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await applyProfileDraft(draft.draft.id);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
      cancelAll();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось применить изменения.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDiscardDraft = async () => {
    if (!draft?.draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await discardProfileDraft(draft.draft.id);
      void queryClient.invalidateQueries({ queryKey: ["profileDraft"] });
      cancelAll();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Не удалось отклонить изменения.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Профиль</Text>

      {isLoading && phase === "idle" && <ActivityIndicator color={colors.primary} />}

      {phase === "idle" && !isLoading && data?.profile && (
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>{data.profile.summary}</Text>
          {data.capabilities.length > 0 && (
            <View style={styles.chipRow}>
              {data.capabilities.map((cap) => (
                <View key={cap.id} style={styles.chip}>
                  <Text style={styles.chipText}>{cap.label}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {phase === "idle" && !isLoading && !data?.profile && (
        <Text style={styles.body}>
          Расскажите текстом, что вы умеете, какие у вас инструменты, транспорт
          или другие ресурсы — AI соберёт из этого профиль возможностей.
        </Text>
      )}

      {phase === "transcribing" && (
        <View style={styles.processingBox}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.processingText}>Распознаём голос…</Text>
          {pollTimedOut && (
            <>
              <Text style={styles.hint}>Это занимает больше времени, чем обычно.</Text>
              <PrimaryButton label="Проверить снова" variant="secondary" onPress={() => void inputQuery.refetch()} />
            </>
          )}
        </View>
      )}

      {phase === "transcript_review" && (
        <View style={styles.reviewBox}>
          <Text style={styles.reviewTitle}>Проверьте распознанный текст</Text>
          <Text style={styles.hint}>Можно поправить перед отправкой в AI.</Text>
          <TextInput
            style={styles.textArea}
            value={transcriptText}
            onChangeText={setTranscriptText}
            multiline
          />
          {submitError && <Text style={styles.error}>{submitError}</Text>}
          <PrimaryButton
            label="Отправить AI"
            onPress={onConfirmTranscript}
            loading={submitting}
            disabled={transcriptText.trim().length === 0}
          />
          <PrimaryButton label="Отмена" variant="secondary" onPress={cancelAll} disabled={submitting} />
        </View>
      )}

      {phase === "processing" && (
        <View style={styles.processingBox}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.processingText}>AI обрабатывает вашу запись…</Text>
          {pollTimedOut && (
            <>
              <Text style={styles.hint}>Обработка занимает больше времени, чем обычно.</Text>
              <PrimaryButton label="Проверить снова" variant="secondary" onPress={() => void draftQuery.refetch()} />
            </>
          )}
        </View>
      )}

      {phase === "draft_review" && draft?.draft && (
        <View style={styles.reviewBox}>
          <Text style={styles.reviewTitle}>AI предлагает изменить профиль</Text>
          <Text style={styles.summaryText}>{draft.draft.summary}</Text>
          {(draft.diff.addedCapabilities.length > 0 || draft.diff.addedResources.length > 0) && (
            <View style={styles.diffSection}>
              <Text style={styles.diffLabel}>Добавится:</Text>
              {[...draft.diff.addedCapabilities, ...draft.diff.addedResources].map((label) => (
                <Text key={label} style={styles.diffAdded}>+ {label}</Text>
              ))}
            </View>
          )}
          {(draft.diff.removedCapabilities.length > 0 || draft.diff.removedResources.length > 0) && (
            <View style={styles.diffSection}>
              <Text style={styles.diffLabel}>Уберётся:</Text>
              {[...draft.diff.removedCapabilities, ...draft.diff.removedResources].map((label) => (
                <Text key={label} style={styles.diffRemoved}>− {label}</Text>
              ))}
            </View>
          )}
          {submitError && <Text style={styles.error}>{submitError}</Text>}
          <PrimaryButton label="Применить" onPress={onApplyDraft} loading={submitting} />
          <PrimaryButton label="Отклонить" variant="secondary" onPress={onDiscardDraft} disabled={submitting} />
        </View>
      )}

      {phase === "idle" && composerOpen && (
        <>
          <AiInputField
            value={text}
            onChangeText={setText}
            placeholder="Например: делаю мелкий ремонт, есть свой инструмент и грузовой велосипед"
            audioUri={audioUri}
            onAudioRecorded={setAudioUri}
            onAudioDeleted={() => setAudioUri(null)}
          />
          {submitError && <Text style={styles.error}>{submitError}</Text>}
          <PrimaryButton
            label="Отправить AI"
            onPress={onSubmit}
            loading={submitting}
            disabled={text.trim().length === 0 && !audioUri}
          />
        </>
      )}

      {phase === "idle" && !composerOpen && (
        <PrimaryButton
          label={data?.profile ? "Рассказать ещё" : "Создать AI-профиль"}
          onPress={() => setComposerOpen(true)}
        />
      )}

      {phase === "idle" && (
        <View style={styles.navRow}>
          <View style={styles.navButton}>
            <PrimaryButton label="Уведомления" variant="secondary" onPress={() => router.push("/notifications")} />
          </View>
          <View style={styles.navButton}>
            <PrimaryButton label="Настройки" variant="secondary" onPress={() => router.push("/settings")} />
          </View>
        </View>
      )}

      {phase === "idle" && (
        <PrimaryButton label="Выйти" variant="secondary" loading={loggingOut} onPress={onLogout} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
  hint: { ...typography.caption, color: colors.textSecondary },
  summaryBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  summaryText: { ...typography.body, color: colors.textPrimary },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { backgroundColor: colors.surfaceAlt, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  chipText: { ...typography.caption, color: colors.textPrimary },
  processingBox: { alignItems: "center", gap: spacing.xs, padding: spacing.md },
  processingText: { ...typography.body, color: colors.textSecondary },
  navRow: { flexDirection: "row", gap: spacing.sm },
  navButton: { flex: 1 },
  reviewBox: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  reviewTitle: { ...typography.subtitle, color: colors.textPrimary },
  textArea: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    color: colors.textPrimary,
    minHeight: 96,
    textAlignVertical: "top",
  },
  diffSection: { gap: 2 },
  diffLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  diffAdded: { ...typography.body, color: colors.success },
  diffRemoved: { ...typography.body, color: colors.danger },
});
