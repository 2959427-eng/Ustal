import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { router, Stack, usePathname } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { isSessionUsable } from "../src/api/auth";
import { restoreSession } from "../src/api/startup";
import { queryClient } from "../src/state/query-client";
import { ensurePushRegistered } from "../src/notifications/push";
import { listenForNotificationTaps } from "../src/notifications/taps";
import { consumeOrderRoute, rememberOrder } from "../src/notifications/navigation";
import { withDeadline } from "../src/lib/deadline";

export default function RootLayout() {
  const pathname = usePathname();
  const navigationReady = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "failed" | "authenticated" | "anonymous">("loading");
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    const taps = listenForNotificationTaps(() => navigationReady.current).then((cleanup) => { if (active) stop = cleanup; else cleanup(); });
    void (async () => {
      await withDeadline(taps, 3_000).catch(() => {});
      const result = await restoreSession();
      if (active) setState(result.state === "storage_unavailable" ? "failed" : isSessionUsable(result) ? "authenticated" : "anonymous");
    })();
    return () => { active = false; stop?.(); };
  }, [attempt]);

  useEffect(() => {
    navigationReady.current = state === "authenticated" || state === "anonymous";
    if (state === "authenticated") {
      const pending = consumeOrderRoute();
      if (pending) router.replace(pending);
      else if (!pathname.startsWith("/order/")) router.replace("/(tabs)");
      void ensurePushRegistered();
    } else if (state === "anonymous") {
      if (pathname.startsWith("/order/")) rememberOrder(pathname.slice("/order/".length));
      router.replace("/onboarding");
    }
    // Startup routing runs once per restoration, never overwrites subsequent navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (state === "loading" || state === "failed") return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 16 }}>
      {state === "loading" ? <><ActivityIndicator /><Text>Восстанавливаем сессию…</Text></> : <>
        <Text>Не удалось прочитать сохранённую сессию. Разблокируйте устройство и повторите попытку.</Text>
        <Pressable accessibilityRole="button" onPress={() => { setState("loading"); setAttempt((n) => n + 1); }}><Text>Повторить</Text></Pressable>
      </>}
    </View>
  );
  return <SafeAreaProvider><QueryClientProvider client={queryClient}>
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="onboarding" /><Stack.Screen name="(auth)" /><Stack.Screen name="(tabs)" />
    </Stack>
  </QueryClientProvider></SafeAreaProvider>;
}
