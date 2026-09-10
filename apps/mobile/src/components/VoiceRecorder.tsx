import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { Audio, type AVPlaybackStatus } from "expo-av";
import { colors, radii, spacing, typography } from "../theme/tokens";

interface Props {
  /** Локальный uri уже записанного аудио, либо null — идём в режим записи. */
  uri: string | null;
  onRecorded: (uri: string) => void;
  onDelete: () => void;
  disabled?: boolean;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Запись голоса (раздел 8 ТЗ): запись → прослушивание → удаление →
 * перезапись. Формат записи — HIGH_QUALITY preset expo-av (`.m4a`/AAC),
 * это совпадает с допустимыми MIME-типами на сервере (`audio/m4a` —
 * packages/validation/src/media.ts MEDIA_LIMITS.audio), поэтому загрузка
 * идёт без перекодирования на клиенте.
 *
 * `uri` контролируется родителем (AiInputField): null — ещё не
 * записано/удалено, значение — итоговая запись, готовая к отправке. Фаза
 * «идёт запись» — внутреннее состояние компонента, наружу не всплывает.
 */
export function VoiceRecorder({ uri, onRecorded, onDelete, disabled }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => {
      void recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  const startRecording = async () => {
    setPermissionError(null);
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setPermissionError("Нужен доступ к микрофону, чтобы записать голосовое сообщение.");
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY, (status) => {
        if (status.isRecording) setElapsedMs(status.durationMillis ?? 0);
      });
      recordingRef.current = recording;
      setElapsedMs(0);
      setIsRecording(true);
    } catch {
      setPermissionError("Не удалось начать запись. Попробуйте ещё раз.");
    }
  };

  const stopRecording = async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const recordedUri = recording.getURI();
      if (recordedUri) onRecorded(recordedUri);
    } catch {
      setPermissionError("Не удалось сохранить запись. Попробуйте ещё раз.");
    }
  };

  const togglePlayback = async () => {
    if (!uri) return;
    try {
      if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded && status.isPlaying) {
          await soundRef.current.pauseAsync();
          setIsPlaying(false);
          return;
        }
        await soundRef.current.playAsync();
        setIsPlaying(true);
        return;
      }
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
      soundRef.current = sound;
      setIsPlaying(true);
      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (status.isLoaded && status.didJustFinish) {
          setIsPlaying(false);
          void sound.setPositionAsync(0);
        }
      });
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
        onPress: async () => {
          await soundRef.current?.unloadAsync().catch(() => {});
          soundRef.current = null;
          setIsPlaying(false);
          onDelete();
        },
      },
    ]);
  };

  if (uri) {
    return (
      <View style={styles.row}>
        <Pressable onPress={togglePlayback} disabled={disabled} style={styles.circleButton} accessibilityRole="button">
          <Text style={styles.circleIcon}>{isPlaying ? "❚❚" : "▶"}</Text>
        </Pressable>
        <Text style={styles.label}>Голосовое сообщение записано</Text>
        <Pressable onPress={handleDelete} disabled={disabled} hitSlop={8} accessibilityRole="button">
          <Text style={styles.deleteText}>Удалить</Text>
        </Pressable>
      </View>
    );
  }

  if (isRecording) {
    return (
      <View style={styles.row}>
        <Pressable onPress={stopRecording} style={[styles.circleButton, styles.circleButtonActive]} accessibilityRole="button">
          <Text style={styles.circleIcon}>■</Text>
        </Pressable>
        <Text style={styles.label}>Идёт запись… {formatMs(elapsedMs)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.column}>
      <View style={styles.row}>
        <Pressable onPress={startRecording} disabled={disabled} style={styles.circleButton} accessibilityRole="button">
          <Text style={styles.circleIcon}>●</Text>
        </Pressable>
        <Text style={styles.label}>Записать голосом</Text>
      </View>
      {permissionError && <Text style={styles.error}>{permissionError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: spacing.xs },
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
