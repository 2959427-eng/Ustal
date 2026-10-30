import { Tabs } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useNotificationBadges } from "../../src/notifications/badges";
import { colors } from "../../src/theme/tokens";

/**
 * Навигация верхнего уровня (новый интерфейс, 2026-10-28): нижняя панель «Главная · Заказы · Профиль».
 * Заменяет прежние пилюли «Возможности / Заказы» в шапке (HomeHeader) и вход в профиль по аватару.
 * «Главная» — лента подобранных заказов (app/(tabs)/index.tsx), «Заказы» — мои заказы и мои отклики
 * (app/(tabs)/orders.tsx), «Профиль» — прежний «Мой профиль» (app/(tabs)/account.tsx).
 * Бейджи — только useNotificationBadges (непрочитанные уведомления), как раньше на пилюлях.
 * create и profile (навыки и ресурсы) — по-прежнему маршруты без вкладки (router.push).
 * Окно согласия на ИИ при входе не показывается (2026-10-26): оно открывается перед первой ИИ-обработкой.
 */
export default function TabsLayout() {
  const badges = useNotificationBadges();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Главная",
          tabBarAccessibilityLabel: "Главная",
          tabBarBadge: badges.opportunities || undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "Заказы",
          tabBarAccessibilityLabel: "Заказы",
          tabBarBadge: badges.orders || undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="document-text-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Профиль",
          tabBarAccessibilityLabel: "Профиль",
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen name="create" options={{ href: null, tabBarStyle: { display: "none" } }} />
      <Tabs.Screen name="profile" options={{ href: null, tabBarStyle: { display: "none" } }} />
    </Tabs>
  );
}
