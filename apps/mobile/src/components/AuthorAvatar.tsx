import { View, Text, Image, StyleSheet } from "react-native";
import { colors, typography } from "../theme/tokens";
import { getMediaUrl } from "../api/media";

interface Props {
  name: string;
  avatarMediaId: string | null;
  size?: number;
}

/** Круглая аватарка; без фото — первая буква имени. */
export function AuthorAvatar({ name, avatarMediaId, size = 40 }: Props) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (avatarMediaId) {
    return <Image source={{ uri: getMediaUrl(avatarMediaId) }} style={[styles.img, box]} />;
  }
  return (
    <View style={[styles.fallback, box]}>
      <Text style={[styles.letter, { fontSize: size * 0.42 }]}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: colors.surface },
  fallback: { backgroundColor: colors.primaryTintBg, alignItems: "center", justifyContent: "center" },
  letter: { color: colors.primary, fontWeight: "600" },
});
