import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import type { City } from "../api/cities";
import { colors, spacing, typography } from "../theme/tokens";

import { filterCities } from "../utils/citySearch";

export function CityPicker({ cities, loading, error, onRetry, selectedId, busyId, onSelect }: {
  cities: City[]; loading: boolean; error?: boolean; onRetry: () => void;
  selectedId?: string | null; busyId?: string | null; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterCities(cities, query), [cities, query]);
  return <View style={styles.container}>
    <TextInput style={styles.search} value={query} onChangeText={setQuery} placeholder="Название города или региона" accessibilityLabel="Поиск города" autoCorrect={false} />
    {loading ? <ActivityIndicator color={colors.primary} /> : error ? <View>
      <Text style={styles.secondary}>Не удалось загрузить города.</Text>
      <Pressable onPress={onRetry} accessibilityRole="button"><Text style={styles.retry}>Повторить</Text></Pressable>
    </View> : <FlatList
      data={filtered} keyExtractor={(city) => city.id} keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<Text style={styles.secondary}>Город не найден. Проверьте название.</Text>}
      renderItem={({ item }) => <Pressable disabled={!!busyId} accessibilityRole="button" accessibilityState={{ selected: selectedId === item.id, disabled: !!busyId }} accessibilityLabel={`${item.name}, ${item.regionName}`} onPress={() => onSelect(item.id)} style={styles.row}>
        <View style={styles.label}><Text style={styles.name}>{item.name}</Text><Text style={styles.secondary}>{item.regionName}</Text></View>
        {busyId === item.id ? <ActivityIndicator color={colors.primary} /> : selectedId === item.id ? <Text style={styles.retry}>✓</Text> : null}
      </Pressable>}
    />}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, gap: spacing.md },
  search: { ...typography.body, color: colors.textPrimary, backgroundColor: colors.surface, borderRadius: 14, padding: spacing.md },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.md, borderBottomWidth: 1, borderColor: colors.borderLight },
  label: { flex: 1, gap: 4 },
  name: { ...typography.body, color: colors.textPrimary },
  secondary: { ...typography.caption, color: colors.textSecondary },
  retry: { ...typography.body, color: colors.primary, paddingVertical: spacing.sm },
});
