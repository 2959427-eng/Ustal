import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { primeTokenCache } from "../src/api/client";

const queryClient = new QueryClient();

/**
 * Корневой layout. Восстанавливает сессию из SecureStore перед показом
 * навигации (раздел 5 ТЗ: "восстановление сессии после перезапуска").
 * Splash/Onboarding/Auth — отдельные роуты вне (tabs), (tabs) — нижняя
 * навигация из 5 вкладок (раздел 26 ТЗ).
 */
export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    primeTokenCache().finally(() => setReady(true));
  }, []);

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
