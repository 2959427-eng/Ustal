import { FlatList, Pressable, Text, StyleSheet, View } from "react-native";
import { colors, spacing, typography, radii } from "../../src/theme/tokens";

// Статичный список на время Foundation — реальный экран делает
// GET /cities через apiClient (packages/api-client) начиная с Фазы 2.
const SEED_CITIES = ["Владивосток", "Уссурийск", "Хабаровск"];

export default function SelectCityScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Выберите город</Text>
      <FlatList
        data={SEED_CITIES}
        keyExtractor={(item) => item}
        renderItem={({ item }) => (
          <Pressable style={styles.item}>
            <Text style={styles.itemText}>{item}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, backgroundColor: colors.background },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.md },
  item: { padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.surface, marginBottom: spacing.xs },
  itemText: { ...typography.body, color: colors.textPrimary },
});
