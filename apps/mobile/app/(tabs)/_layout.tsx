import { Tabs } from "expo-router";

/**
 * Навигация верхнего уровня: только два реальных экрана — «Возможности» и
 * «Заказы» (макет Main.dc.html), переключение между ними — пилюли в шапке
 * (src/components/HomeHeader.tsx), поэтому нижний таббар скрыт целиком
 * (`tabBarStyle: { display: "none" }`) — дублировать те же две кнопки снизу
 * не нужно. Создание заказа — композер внизу «Заказов», отклики — иконка в
 * шапке, профиль/AI-профиль и настройки — аватар в шапке. Экраны
 * create/responses/profile остаются реальными маршрутами (router.push).
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Возможности" }} />
      <Tabs.Screen name="orders" options={{ title: "Заказы" }} />
      <Tabs.Screen name="create" options={{ href: null }} />
      <Tabs.Screen name="responses" options={{ href: null }} />
      <Tabs.Screen name="account" options={{ href: null }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  );
}
