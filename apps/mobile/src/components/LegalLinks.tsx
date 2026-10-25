import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import Constants from "expo-constants";
import { legalLinks, legalUrl } from "../lib/legal-links";

export function LegalLinks() {
  const [error, setError] = useState<string | null>(null);
  const open = async (page: typeof legalLinks[number][0]) => {
    setError(null);
    try {
      const origin = Constants.expoConfig?.extra?.apiBaseUrl;
      if (typeof origin !== "string") throw Error("missing_legal_origin");
      await Linking.openURL(legalUrl(origin, page));
    } catch { setError("Не удалось открыть страницу USTAL. Проверьте подключение и повторите попытку."); }
  };
  return <View style={{ gap: 12, paddingVertical: 16 }}>
    {legalLinks.map(([page, label]) => <Pressable key={page} accessibilityRole="link" onPress={() => void open(page)}><Text style={{ color: "#075c8c", textDecorationLine: "underline" }}>{label}</Text></Pressable>)}
    {error && <Text accessibilityRole="alert">{error}</Text>}
  </View>;
}
