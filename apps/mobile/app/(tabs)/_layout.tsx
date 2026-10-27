import { Tabs } from "expo-router";

/**
 * Навигация верхнего уровня: только два реальных экрана — «Возможности» и
 * «Заказы» (макет Main.dc.html), переключение между ними — пилюли в шапке
 * (src/components/HomeHeader.tsx), поэтому нижний таббар скрыт целиком
 * (`tabBarStyle: { display: "none" }`) — дублировать те же две кнопки снизу
 * не нужно. Создание заказа — композер внизу «Заказов», отклики — иконка в
 * шапке, профиль/AI-профиль и настройки — аватар в шапке. Экраны
 * create/profile остаются реальными маршрутами (router.push). «Мои отклики»
 * (2026-09-30) перенесены в корневой стек (app/responses.tsx): у экранов вкладок
 * нет свайпа «назад» на iOS, а кнопку «← Назад» на этом экране убрали.
 */
export default function TabsLayout() {
  // Окно согласия на ИИ при входе не показывается (2026-10-26): оно открывается перед первой ИИ-обработкой
  // (checkAiAction в профиле, заказе и повторе разбора). Решение меняется в «Аккаунт» → «Передача данных AI».
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
      <Tabs.Screen name="account" options={{ href: null }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  );
}
