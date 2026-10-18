import * as SecureStore from "expo-secure-store";
import { withDeadline } from "../lib/deadline";

const SESSION_KEY = "ustal.session.v1";
const ACCESS_TOKEN_KEY = "ustal.accessToken";
const REFRESH_TOKEN_KEY = "ustal.refreshToken";
let epoch = 0;
let writes: Promise<void> = Promise.resolve();
export function invalidateTokenWrites(): void { epoch += 1; }

// Native keychain calls cannot be aborted. Serialize the actual promises (not
// their timeout wrappers), so a late A write can never land after B's credentials.
function mutate(operation: () => Promise<void>): Promise<void> {
  const task = writes.then(operation);
  writes = task.catch(() => {});
  return withDeadline(task);
}
export function saveTokens(accessToken: string, refreshToken: string): Promise<void> {
  const current = epoch;
  return mutate(async () => {
    if (current !== epoch) throw new Error("Session changed");
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({ accessToken, refreshToken }));
  });
}
async function readToken(name: "accessToken" | "refreshToken", legacyKey: string): Promise<string | null> {
  return withDeadline((async () => {
    await writes;
    const stored = await SecureStore.getItemAsync(SESSION_KEY);
    if (stored) {
      const pair = JSON.parse(stored) as Record<string, unknown>;
      if (typeof pair[name] !== "string") throw new Error("Invalid stored session");
      return pair[name] as string;
    }
    return SecureStore.getItemAsync(legacyKey);
  })());
}
export function getAccessToken(): Promise<string | null> { return readToken("accessToken", ACCESS_TOKEN_KEY); }
export function getRefreshToken(): Promise<string | null> { return readToken("refreshToken", REFRESH_TOKEN_KEY); }
export function clearTokens(): Promise<void> {
  invalidateTokenWrites();
  return mutate(async () => {
    await Promise.all([SESSION_KEY, ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY].map((key) => SecureStore.deleteItemAsync(key)));
  });
}
