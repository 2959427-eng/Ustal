import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, Keyboard } from "react-native";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { colors, radii, spacing, typography } from "../theme/tokens";

interface Props {
  /** Локальный uri уже записанного аудио, либо null — идём в режим записи. */
  uri: string | null;
  onRecorded: (uri: string) => void;
  onDelete: () => void;
  disabled?: boolean;
  compact?: boolean;
  onRecordingChange?: (active: boolean) => void;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Запись голоса (раздел 8 ТЗ): запись → прослушивание → удаление →
 * перезапись. Формат записи — HIGH_QUALITY preset expo-audio (`.m4a`/AAC),
 * это совпадает с допустимыми MIME-типами на сервере (`audio/m4a` —
 * packages/validation/src/media.ts MEDIA_LIMITS.audio), поэтому загрузка
 * идёт без перекодирования на клиенте.
 *
 * `uri` контролируется родителем (AiInputField): null — ещё не
 * записано/удалено, значение — итоговая запись, готовая к отправке. Фаза
 * «идёт запись» — внутреннее состояние компонента, наружу не всплывает.
 */
export function VoiceRecorder({ uri, onRecorded, onDelete, disabled, compact = false, onRecordingChange }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const recording = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recording);
  const player = useAudioPlayer(uri);
  const playbackStatus = useAudioPlayerStatus(player);
  const elapsedMs = recorderState.durationMillis;
  const isPlaying = playbackStatus.playing;

  useEffect(() => {
    if (playbackStatus.didJustFinish) void player.seekTo(0).catch(() => {});
  }, [player, playbackStatus.didJustFinish]);

  const startRecording = async () => {
    if (compact) Keyboard.dismiss();
    setPermissionError(null);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setPermissionError("Нужен доступ к микрофону, чтобы записать голосовое сообщение.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recording.prepareToRecordAsync();
      recording.record();
      setIsRecording(true);
      onRecordingChange?.(true);
    } catch {
      setPermissionError("Не удалось начать запись. Попробуйте ещё раз.");
    }
  };

  const stopRecording = async () => {
    try {
      await recording.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const recordedUri = recording.uri;
      if (recordedUri) onRecorded(recordedUri);
    } catch {
      setPermissionError("Не удалось сохранить запись. Попробуйте ещё раз.");
    } finally {
      setIsRecording(false);
      onRecordingChange?.(false);
    }
  };

  const togglePlayback = async () => {
    if (!uri) return;
    try {
      if (player.playing) {
        player.pause();
        return;
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      player.play();
    } catch {
      setPermissionError("Не удалось воспроизвести запись.");
    }
  };

  const handleDelete = () => {
    Alert.alert("Удалить запись?", undefined, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: () => {
          player.pause();
          onDelete();
        },
      },
    ]);
  };

  if (uri) {
    return (
      <View style={styles.row}>
        <Pressable onPress={togglePlayback} disabled={disabled} style={[styles.circleButton, compact && styles.compactPlayback]} accessibilityRole="button" accessibilityLabel={isPlaying ? "Приостановить запись" : "Прослушать запись"}>
          <Text style={styles.circleIcon}>{isPlaying ? "❚❚" : "▶"}</Text>
        </Pressable>
        <Text style={styles.label}>{compact ? "Голосовое" : "Голосовое сообщение записано"}</Text>
        <Pressable onPress={handleDelete} disabled={disabled} hitSlop={8} accessibilityRole="button">
          <Text style={styles.deleteText}>Удалить</Text>
        </Pressable>
      </View>
    );
  }

  if (isRecording) {
    return (
      <View style={styles.row}>
        <Pressable onPress={stopRecording} style={[styles.circleButton, styles.circleButtonActive, compact && styles.compactPlayback]} accessibilityRole="button" accessibilityLabel="Остановить запись">
          <Text style={styles.circleIcon}>■</Text>
        </Pressable>
        <Text style={styles.label}>Идёт запись… {formatMs(elapsedMs)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.column}>
      <View style={styles.row}>
        <Pressable onPress={startRecording} disabled={disabled} style={[styles.circleButton, compact && styles.compactButton]} accessibilityRole="button" accessibilityLabel="Записать заказ голосом" accessibilityState={{ disabled: !!disabled }}>
          {compact ? (
            <View accessible={false} style={styles.microphone}>
              <View style={styles.micCapsule} />
              <View style={styles.micCradle} />
              <View style={styles.micStem} />
              <View style={styles.micBase} />
            </View>
          ) : <Text style={styles.circleIcon}>●</Text>}
        </Pressable>
        {!compact && <Text style={styles.label}>Записать голосом</Text>}
      </View>
      {permissionError && <Text accessibilityRole="alert" style={[styles.error, compact && styles.compactError]}>{permissionError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: spacing.xs },
  compactButton: { backgroundColor: "transparent" },
  compactError: { position: "absolute", right: 0, bottom: 52, width: 260, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  compactPlayback: { backgroundColor: colors.textPrimary },
  microphone: { width: 24, height: 26, alignItems: "center" },
  micCapsule: { position: "absolute", top: 1, width: 8, height: 14, borderWidth: 1.8, borderColor: colors.textPrimary, borderRadius: 5 },
  micCradle: { position: "absolute", top: 9, width: 16, height: 11, borderWidth: 1.8, borderTopWidth: 0, borderColor: colors.textPrimary, borderBottomLeftRadius: 9, borderBottomRightRadius: 9 },
  micStem: { position: "absolute", top: 19, width: 1.8, height: 5, backgroundColor: colors.textPrimary },
  micBase: { position: "absolute", top: 23, width: 9, height: 1.8, borderRadius: 1, backgroundColor: colors.textPrimary },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  circleButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  circleButtonActive: { backgroundColor: colors.primary },
  circleIcon: { color: colors.textInverse, fontSize: 16 },
  label: { ...typography.body, color: colors.textSecondary, flexShrink: 1 },
  deleteText: { ...typography.caption, color: colors.danger },
  error: { ...typography.caption, color: colors.danger },
});
