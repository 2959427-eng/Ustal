import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { getPublicProfile } from "../../src/api/users";
import { getCities } from "../../src/api/cities";
import { ReputationBlock } from "../../src/components/ReputationBlock";
import { AuthorAvatar } from "../../src/components/AuthorAvatar";
import { colors, spacing, typography } from "../../src/theme/tokens";

/** Публичный профиль (заказчика или исполнителя): две отдельные репутации, без количества оценок. */
export default function UserProfileScreen() {
  const { id, orderId } = useLocalSearchParams<{ id: string; orderId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const query = useQuery({
    queryKey: ["public-profile", id, orderId],
    queryFn: () => getPublicProfile(id, orderId ?? ""),
    retry: false,
  });
  const cities = useQuery({ queryKey: ["cities"], queryFn: getCities, staleTime: 3600_000 });
  const p = query.data;
  const city = p ? cities.data?.find((c) => c.id === p.cityId)?.name : undefined;
  const since = p ? new Date(p.memberSince).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) : "";

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable onPress={() => router.back()} hitSlop={12}>
        <Text style={styles.back}>← Назад</Text>
      </Pressable>
      {query.isLoading && <ActivityIndicator color={colors.primary} />}
      {query.isError && <Text style={styles.hint}>Не удалось загрузить профиль.</Text>}
      {p && (
        <View style={styles.center}>
          <AuthorAvatar name={p.name} avatarMediaId={p.avatarMediaId} size={112} />
          <Text style={styles.name}>{p.name}</Text>
          {city && <Text style={styles.hint}>{city}</Text>}
          <Text style={styles.hint}>На USTAL с {since}</Text>
          {!!p.about && <Text style={styles.about}>{p.about}</Text>}
          <ReputationBlock reputation={p.reputation} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg },
  back: { color: colors.primary, fontSize: 16 },
  center: { alignItems: "center", gap: 8, marginTop: spacing.lg },
  name: { fontSize: 22, fontWeight: "700", color: colors.textPrimary },
  hint: { color: colors.textSecondary, fontSize: 14 },
  about: { color: colors.textPrimary, fontSize: 15, lineHeight: 22, textAlign: "center", marginTop: spacing.md },
});
