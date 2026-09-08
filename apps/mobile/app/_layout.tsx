import { useEffect, useState } from "react";
import { router, Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { primeTokenCache } from "../src/api/client";
import { isSessionUsable, refreshSession } from "../src/api/auth";
import { ensurePushRegistered } from "../src/notifications/push";

const queryClient = new QueryClient();

/**
 * Корневой layout. Восстанавливает сессию из SecureStore перед показом
 * навигации (раздел 5 ТЗ: "восстановление сессии после перезапуска").
 * Splash/Onboarding/Auth — отдельные роуты вне (tabs), (tabs) — нижняя
 * навигация из 5 вкладок (раздел 26 ТЗ).
 *
 * До этой правки (architecture.md §5 п.30) восстановление токена из
 * SecureStore ни на что не влияло — уже вошедший пользователь всё равно
 * каждый раз видел onboarding/экран входа, потому что ничего не
 * перенаправляло его в (tabs). Теперь: если токен есть — сразу редирект в
 * (tabs) и попытка (не блокирующая) зарегистрировать push-токен устройства.
 *
 * 2026-09-08 fix: раньше `refreshSession()` возвращала просто `boolean`, и
 * ЛЮБАЯ ошибка (в том числе временная недоступность API — не только явный
 * отказ backend'а) трактовалась как "не авторизован", отправляя
 * пользователя на экран входа. Теперь `refreshSession()` возвращает
 * состояние (src/api/auth.ts), а `isSessionUsable()` решает по нему: сюда
 * пускаем не только при "refreshed", но и при временной недоступности
 * сети/сервера — токены в этом случае не были тронуты, разлогинивать
 * пользователя не за что. На экран входа отправляем ТОЛЬКО если backend
 * явно отклонил refresh-токен или локальной сессии не было вовсе.
 */
export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    (async () => {
      await primeTokenCache();
      const result = await refreshSession();
      setAuthenticated(isSessionUsable(result));
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready || !authenticated) return;
    router.replace("/(tabs)");
    void ensurePushRegistered();
  }, [ready, authenticated]);

  if (!ready) return null; // Splash остаётся на экране (expo-splash-screen)

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </QueryClientProvider>
  );
}
