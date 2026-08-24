import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors } from "../../src/theme/tokens";

/** Нижняя навигация из 5 вкладок — раздел 26 ТЗ. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Главная", tabBarIcon: ({ color }) => <Text style={{ color }}>⌂</Text> }}
      />
      <Tabs.Screen
        name="orders"
        options={{ title: "Заказы", tabBarIcon: ({ color }) => <Text style={{ color }}>▤</Text> }}
      />
      <Tabs.Screen
        name="create"
        options={{ title: "Создать", tabBarIcon: ({ color }) => <Text style={{ color }}>+</Text> }}
      />
      <Tabs.Screen
        name="responses"
        options={{ title: "Отклики", tabBarIcon: ({ color }) => <Text style={{ color }}>↩</Text> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "Профиль", tabBarIcon: ({ color }) => <Text style={{ color }}>☺</Text> }}
      />
    </Tabs>
  );
}
