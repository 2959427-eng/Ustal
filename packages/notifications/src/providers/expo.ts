import { loadEnv } from "@ustal/config";
import type { PushProvider, PushSendResult } from "../types.js";

interface ExpoResult { status: "ok" | "error"; id?: string; details?: { error?: string } }
function result(value: ExpoResult): PushSendResult {
  const code = value.details?.error;
  return { ok: value.status === "ok", providerMessageId: value.id ?? null,
    invalidToken: code === "DeviceNotRegistered",
    error: value.status === "ok" ? null : code ?? "PushRejected" };
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const env = loadEnv();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([(async () => {
      const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json", ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`PushHTTP${response.status}`);
      return await response.json() as T;
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("PushTimeout")); controller.abort(); }, 15_000); })]);
  } finally { clearTimeout(timer!); }
}
export const expoPushProvider: PushProvider = {
  name: "expo",
  async send(input) {
    try {
      const json = await post<{ data?: ExpoResult | ExpoResult[] }>("send", { to: input.expoPushToken, title: input.title, body: input.body, data: input.data ?? {} });
      const ticket = Array.isArray(json.data) ? json.data[0] : json.data;
      return ticket ? result(ticket) : { ok: false, providerMessageId: null, error: "InvalidPushResponse" };
    } catch { return { ok: false, providerMessageId: null, error: "PushTransportError" }; }
  },
  async receipts(ids) {
    const json = await post<{ data?: Record<string, ExpoResult> }>("getReceipts", { ids });
    if (!json.data) throw new Error("InvalidPushReceipts");
    return Object.fromEntries(Object.entries(json.data).map(([id, receipt]) => [id, result(receipt)]));
  },
};
