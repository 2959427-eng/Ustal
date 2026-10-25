import { useEffect } from "react";
import { router, Tabs } from "expo-router";
import { getAiConsent } from "../../src/api/consents";
import { shouldPromptAiConsent } from "../../src/lib/ai-consent-state";

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
  // Один раз при входе в приложение: если сервер требует согласие на ИИ-обработку, а решения нет (или текст обновился),
  // показываем экран согласия. Отказ не переспрашиваем; решение меняется в «Аккаунт» → «Обработка данных ИИ».
  useEffect(() => {
    void getAiConsent().then((s) => { if (shouldPromptAiConsent(s)) router.push("/ai-consent"); }).catch(() => {});
  }, []);
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
