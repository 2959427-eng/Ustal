import * as SecureStore from "expo-secure-store";

/**
 * Токены — только в Keychain/Keystore через SecureStore, никогда в
 * AsyncStorage (раздел 5 ТЗ: "Не используй обычный AsyncStorage для
 * чувствительных токенов").
 */
const ACCESS_TOKEN_KEY = "ustal.accessToken";
const REFRESH_TOKEN_KEY = "ustal.refreshToken";

export async function saveTokens(accessToken: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
