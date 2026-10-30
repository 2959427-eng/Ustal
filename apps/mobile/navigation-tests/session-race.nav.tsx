/**
 * BLOCKER 2026-10-27 (Codex): обработчик формы пользователя A после logout/login отправлял текст, цену и фото
 * с авторизацией пользователя B. Настоящие expo-router, экраны и ApiClient; сеть — fetch с задержанными ответами.
 * Проверяются фактические исходящие запросы: ни один запрос с данными A не уходит с токеном B (и вообще после выхода A).
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act } from "react";
import { Text, Platform } from "react-native";
import { router, Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AI_CONSENT_GRANT_LABEL, AI_CONSENT_TEXT } from "../src/lib/ai-consent-flow";
import { login, logout } from "../src/api/auth";
import type { PickedPhoto } from "../src/components/PhotoPicker";
import { carrying, hold, installFakeServer, sent, type SentRequest } from "./fake-server";
import TabsLayout from "../app/(tabs)/_layout";
import ProfileScreen from "../app/(tabs)/profile";
import CreateOrderScreen from "../app/(tabs)/create";
import AiConsentScreen from "../app/ai-consent";
import OrdersScreen from "../app/(tabs)/orders";
import { formDraftSession } from "../src/lib/form-drafts";

jest.mock("expo-image-picker", () => ({}));
const mockPhotoPicker: { props?: { photos: PickedPhoto[]; onChange: (p: PickedPhoto[]) => void } } = {};
jest.mock("../src/components/PhotoPicker", () => ({
  PhotoPicker: (props: { photos: PickedPhoto[]; onChange: (p: PickedPhoto[]) => void }) => { mockPhotoPicker.props = props; return null; },
}));
jest.mock("../src/api/session", () => ({
  saveTokens: jest.fn(async () => {}), invalidateTokenWrites: jest.fn(), clearTokens: jest.fn(async () => {}),
  getRefreshToken: jest.fn(async () => "refresh"), getAccessToken: jest.fn(async () => null),
}));
jest.mock("../src/notifications/push", () => ({ resetPushRegistrationState: jest.fn(), unregisterPush: jest.fn(async () => {}) }));

const policy = { id: "p1", purpose: "ai", version: "1", policyHash: "a".repeat(64), status: "approved", content: { humanText: "Полные условия", notice: [...AI_CONSENT_TEXT] } };
const decided = (decisions: unknown[]) => ({ revision: decisions.length, aiConsentPurpose: "ai", outboundEnforcement: true, policies: [policy], decisions });
const grant = { purpose: "ai", policyId: "p1", policyHash: policy.policyHash, decision: "grant", seq: 1, decidedAt: "2026-10-27T00:00:00Z", effective: true };
let consentsFor: Record<string, unknown>;
const serve = (req: SentRequest) => {
  const who = req.auth?.replace("Bearer ", "").replace("-access", "") ?? "anon";
  if (req.path === "/auth/login") { const u = (req.body as { phone: string }).phone.endsWith("1") ? "A" : "B"; return { body: { accessToken: `${u}-access`, refreshToken: `${u}-refresh` } }; }
  if (req.path === "/me/consents" && req.method === "GET") return { body: consentsFor[who] ?? decided([]) };
  if (req.path === "/me/consents" && req.method === "POST") return { body: { changed: true, revision: 1 } };
  if (req.path.startsWith("/cities")) return { body: [] };
  if (req.path.startsWith("/my/") || req.path.startsWith("/notifications")) return { body: { items: [], limit: 50, offset: 0 } };
  if (req.path === "/profile") return { body: { profile: null, capabilities: [], resources: [], restrictions: [] } };
  if (req.path === "/profile/draft") return { body: { draft: null } };
  if (req.path === "/profile/inputs") return { body: { sourceInputId: "in1", status: "queued" } };
  if (req.path === "/orders" && req.method === "POST") return { status: 201, body: { orderId: "o1" } };
  if (req.path.startsWith("/orders/")) return { body: { id: "o1", status: "processing", moderationStatus: "pending" } };
  return { body: {} };
};

function Root() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={client}><Stack screenOptions={{ headerShown: false }} /></QueryClientProvider>
    </SafeAreaProvider>
  );
}
const routes = () => ({
  _layout: Root,
  "(tabs)/_layout": TabsLayout,
  "(tabs)/index": () => <Text>Главная</Text>,
  "(tabs)/orders": OrdersScreen,
  "(tabs)/account": () => <Text>Аккаунт</Text>,
  "(tabs)/profile": ProfileScreen,
  "(tabs)/create": CreateOrderScreen,
  "ai-consent": AiConsentScreen,
  other: () => <Text>Другой экран</Text>,
});
const switchToB = async () => {
  await act(async () => { await logout(); });
  await act(async () => { await login("+70000000002", "pw-B"); });
};
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
/** Ни одного запроса с данными A после выхода A — ни с токеном B, ни без токена. */
const assertNoLeak = (needles: string[], loggedOutAt: number) => {
  for (const needle of needles) {
    expect(carrying(needle).filter((r) => r.auth === "Bearer B-access")).toEqual([]);
    expect(sent.slice(loggedOutAt).filter((r) => JSON.stringify(r.body ?? "").includes(needle))).toEqual([]);
  }
};

beforeEach(async () => {
  consentsFor = { A: decided([grant]), B: decided([grant]) };
  installFakeServer(serve);
  await login("+70000000001", "pw-A");
});

describe("действие A не уходит от имени B (реальные асинхронные гонки, смена токена A→B)", () => {
  it("профиль: проверка согласия A ещё в пути → logout → login B → ответ пришёл: текст A не отправлен ни с каким токеном", async () => {
    renderRouter(routes(), { initialUrl: "/profile" });
    fireEvent.changeText(await screen.findByPlaceholderText(/Опишите себя текстом/), "Профиль A: сварщик");
    const release = hold("GET /me/consents");
    fireEvent.press(screen.getByText("Сохранить"));
    await waitFor(() => expect(sent.some((r) => r.path === "/me/consents" && r.auth === "Bearer A-access")).toBe(true));
    const loggedOutAt = sent.length;
    await switchToB();
    release();
    await flush();
    expect(sent.filter((r) => r.path === "/profile/inputs")).toEqual([]);
    assertNoLeak(["Профиль A: сварщик"], loggedOutAt);
    expect(screen.queryByText("Как работает USTAL")).toBeNull(); // и окно согласия для B не открылось от действия A
  });

  it("заказ: текст, цена и фото A; проверка согласия в пути → смена A→B → заказ не создан, данные A не ушли", async () => {
    renderRouter(routes(), { initialUrl: "/create" });
    fireEvent.changeText(await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами"), "Заказ A: покрасить забор");
    fireEvent.changeText(screen.getByPlaceholderText("Например, 2000"), "7777");
    act(() => mockPhotoPicker.props!.onChange([{ mediaId: "media-of-A", uri: "file:///a.jpg" } as unknown as PickedPhoto]));
    const release = hold("GET /me/consents");
    fireEvent.press(screen.getByText("Продолжить"));
    await waitFor(() => expect(sent.some((r) => r.path === "/me/consents" && r.auth === "Bearer A-access")).toBe(true));
    const loggedOutAt = sent.length;
    await switchToB();
    release();
    await flush();
    expect(sent.filter((r) => r.path === "/orders" && r.method === "POST")).toEqual([]);
    assertNoLeak(["Заказ A: покрасить забор", "777700", "media-of-A"], loggedOutAt);
  });

  it("контроль: в одной сессии тот же сценарий отправляет заказ A с токеном A (данные A, цена, фото)", async () => {
    renderRouter(routes(), { initialUrl: "/create" });
    fireEvent.changeText(await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами"), "Заказ A: покрасить забор");
    fireEvent.changeText(screen.getByPlaceholderText("Например, 2000"), "7777");
    act(() => mockPhotoPicker.props!.onChange([{ mediaId: "media-of-A", uri: "file:///a.jpg" } as unknown as PickedPhoto]));
    fireEvent.press(screen.getByText("Продолжить"));
    await waitFor(() => expect(sent.filter((r) => r.path === "/orders" && r.method === "POST")).toHaveLength(1));
    expect(sent.find((r) => r.path === "/orders")).toMatchObject({ auth: "Bearer A-access", body: { text: "Заказ A: покрасить забор", priceMinor: 777700, mediaIds: ["media-of-A"] } });
  });

  it("окно согласия: показано для A → смена A→B → «Разрешаю» на старом экране не даёт согласие от имени B", async () => {
    consentsFor = { A: decided([]), B: decided([]) };
    renderRouter(routes(), { initialUrl: "/ai-consent" });
    const grantButton = await screen.findByText("Разрешаю и продолжить");
    await switchToB();
    fireEvent.press(grantButton);
    await flush();
    expect(sent.filter((r) => r.path === "/me/consents" && r.method === "POST")).toEqual([]);
  });

  it("заказ: обработчик «Продолжить» из экрана A вызван уже после входа B — запросов с данными A нет вообще", async () => {
    renderRouter(routes(), { initialUrl: "/create" });
    fireEvent.changeText(await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами"), "Заказ A: покрасить забор");
    fireEvent.changeText(screen.getByPlaceholderText("Например, 2000"), "7777");
    act(() => mockPhotoPicker.props!.onChange([{ mediaId: "media-of-A", uri: "file:///a.jpg" } as unknown as PickedPhoto]));
    const staleSubmit = screen.UNSAFE_getByProps({ label: "Продолжить" }).props.onPress as () => Promise<void>;
    const loggedOutAt = sent.length;
    await switchToB();
    await act(async () => { await staleSubmit(); });
    await flush();
    expect(sent.slice(loggedOutAt).filter((r) => r.path === "/me/consents" || r.path === "/orders")).toEqual([]);
    assertNoLeak(["Заказ A: покрасить забор", "777700", "media-of-A"], loggedOutAt);
  });

  it("профиль: обработчик «Сохранить» из экрана A вызван после входа B — текст A не уходит с токеном B", async () => {
    renderRouter(routes(), { initialUrl: "/profile" });
    fireEvent.changeText(await screen.findByPlaceholderText(/Опишите себя текстом/), "Профиль A: сварщик");
    const staleSubmit = screen.UNSAFE_getByProps({ label: "Сохранить" }).props.onPress as () => Promise<void>;
    const loggedOutAt = sent.length;
    await switchToB();
    await act(async () => { await staleSubmit(); });
    await flush();
    expect(sent.slice(loggedOutAt).filter((r) => r.path === "/profile/inputs")).toEqual([]);
    assertNoLeak(["Профиль A: сварщик"], loggedOutAt);
  });

  // Codex 2026-10-27 (v4): logout A → login B → экран согласия обновился (загрузил состояние B) → старый обработчик A.
  const refreshConsentScreen = async () => {
    act(() => router.push("/other"));
    await screen.findByText("Другой экран");
    await act(async () => { router.back(); });
    // Тот же экземпляр экрана (не новый): useFocusEffect перезагружает состояние уже в сессии B.
    await waitFor(() => expect(screen.getByText("Как работает USTAL")).toBeTruthy());
    await flush();
  };
  const consentPosts = () => sent.filter((r) => r.path === "/me/consents" && r.method === "POST");

  it("окно согласия: обработчик «Разрешаю» из сессии A после входа B и обновления экрана не даёт grant от имени B", async () => {
    consentsFor = { A: decided([]), B: decided([]) };
    renderRouter(routes(), { initialUrl: "/ai-consent" });
    await screen.findByText(AI_CONSENT_GRANT_LABEL);
    const staleGrant = screen.UNSAFE_getByProps({ label: AI_CONSENT_GRANT_LABEL }).props.onPress as () => void;
    await switchToB();
    await refreshConsentScreen();
    expect(sent.some((r) => r.path === "/me/consents" && r.method === "GET" && r.auth === "Bearer B-access")).toBe(true);
    act(() => staleGrant());
    await flush();
    expect(consentPosts()).toEqual([]);
    // Новый обработчик (сессия B) работает: B сам даёт согласие своим токеном.
    fireEvent.press(screen.getByText(AI_CONSENT_GRANT_LABEL));
    await waitFor(() => expect(consentPosts()).toHaveLength(1));
    expect(consentPosts()[0]).toMatchObject({ auth: "Bearer B-access", body: { decision: "grant" } });
  });

  it("окно согласия: обработчик «Отозвать разрешение» из сессии A после входа B и обновления экрана не отзывает согласие B", async () => {
    renderRouter(routes(), { initialUrl: "/ai-consent" });
    await screen.findByText("Отозвать разрешение");
    const staleRevoke = screen.UNSAFE_getByProps({ label: "Отозвать разрешение" }).props.onPress as () => void;
    await switchToB();
    await refreshConsentScreen();
    act(() => staleRevoke());
    await flush();
    expect(consentPosts()).toEqual([]);
  });

  it("режим off: обработчик отзыва прежнего разрешения A после входа B не отправляет revoke", async () => {
    const offWithGrant = { ...decided([grant]), outboundEnforcement: false };
    consentsFor = { A: offWithGrant, B: offWithGrant };
    renderRouter(routes(), { initialUrl: "/ai-consent" });
    await screen.findByText("Отозвать разрешение");
    const staleRevoke = screen.UNSAFE_getByProps({ label: "Отозвать разрешение" }).props.onPress as () => void;
    await switchToB();
    await refreshConsentScreen();
    act(() => staleRevoke());
    await flush();
    expect(consentPosts()).toEqual([]);
  });
});

describe("v6: prefillText и состояние экрана заказа привязаны к сессии (Codex: A → logout → login B на сохранённом экране)", () => {
  const ORDER_A = "Заказ A из композера";
  const createText = () => screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами");
  const openCreateFromComposer = async (text: string) => {
    fireEvent.changeText(await screen.findByPlaceholderText("Создать заказ"), text);
    fireEvent.press(screen.getByLabelText("Продолжить создание заказа"));
    await waitFor(() => expect(screen.getByDisplayValue(text)).toBeTruthy());
  };

  it("A→B с сохранённым экраном и prefillText: данные A не видны и не отправляются; B создаёт свой заказ своим токеном", async () => {
    renderRouter(routes(), { initialUrl: "/orders" });
    await openCreateFromComposer(ORDER_A);
    fireEvent.changeText(screen.getByPlaceholderText("Например, 2000"), "5000");
    const loggedOutAt = sent.length;
    await switchToB();
    await flush();
    expect(screen.queryByDisplayValue(ORDER_A)).toBeNull();
    expect(screen.queryByDisplayValue("5000")).toBeNull();

    fireEvent.changeText(await createText(), "Заказ B: вывезти мусор");
    fireEvent.press(screen.getByText("Продолжить"));
    await waitFor(() => expect(sent.filter((r) => r.path === "/orders" && r.method === "POST")).toHaveLength(1));
    expect(sent.find((r) => r.path === "/orders" && r.method === "POST")).toMatchObject({ auth: "Bearer B-access", body: { text: "Заказ B: вывезти мусор" } });
    assertNoLeak([ORDER_A, "500000"], loggedOutAt);
  });

  it("параметры навигации A (prefillText + сессия A), открытые уже в сессии B, не восстанавливают текст A", async () => {
    renderRouter(routes(), { initialUrl: "/orders" });
    await openCreateFromComposer(ORDER_A);
    const aSession = formDraftSession().id!;
    await switchToB();
    act(() => router.push({ pathname: "/create", params: { prefillText: ORDER_A, prefillSession: aSession } }));
    expect((await createText()).props.value).toBe("");
    act(() => router.push({ pathname: "/create", params: { prefillText: ORDER_A } })); // без номера сессии — тоже нет
    await flush();
    expect(screen.queryByDisplayValue(ORDER_A)).toBeNull();
  });

  it("неотправленный текст композера «Заказы» A не остаётся у B", async () => {
    renderRouter(routes(), { initialUrl: "/orders" });
    fireEvent.changeText(await screen.findByPlaceholderText("Создать заказ"), ORDER_A);
    await switchToB();
    await flush();
    expect(screen.queryByDisplayValue(ORDER_A)).toBeNull();
    expect(screen.queryByLabelText("Продолжить создание заказа")).toBeNull();
  });

  it("внутри сессии A: композер → заказ → окно согласия → отказ → профиль → назад к заказу — текст на месте", async () => {
    consentsFor = { A: decided([]), B: decided([]) };
    renderRouter(routes(), { initialUrl: "/orders" });
    await openCreateFromComposer(ORDER_A);
    fireEvent.press(screen.getByText("Продолжить"));
    if (Platform.OS === "android") {
      const input = await screen.findByPlaceholderText(/Опишите себя текстом/);
      expect(screen.queryByText("Как работает USTAL")).toBeNull();
      expect(sent.filter((r) => r.path === "/orders" && r.method === "POST")).toEqual([]);
      fireEvent.changeText(input, "Умею красить заборы");
      fireEvent.press(screen.getByText("Сохранить"));
    }
    fireEvent.press(await screen.findByText("Не разрешаю"));
    await screen.findByPlaceholderText(/Опишите себя текстом/);
    act(() => router.navigate("/create"));
    await waitFor(() => expect(screen.getByDisplayValue(ORDER_A)).toBeTruthy());
    expect(sent.filter((r) => r.path === "/orders" && r.method === "POST")).toEqual([]);
  });
});

describe("v7: криптостойкий id сессии — перезапуск приложения и повторный вход", () => {
  const ORDER_A = "Заказ A до перезапуска";
  const createText = () => screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами");
  const orderPosts = () => sent.filter((r) => r.path === "/orders" && r.method === "POST");

  it("A→B после перезапуска JS: prefillText A с id прежнего запуска (и бывшим счётчиком «1») не восстанавливается и не отправляется", async () => {
    let previousLaunchId = "";
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- отдельный «запуск» модуля
    jest.isolateModules(() => { previousLaunchId = (require("../src/lib/form-drafts") as typeof import("../src/lib/form-drafts")).formDraftSession().id!; });
    await switchToB();
    expect(formDraftSession().id).not.toBe(previousLaunchId);
    renderRouter(routes(), { initialUrl: "/orders" });
    for (const prefillSession of [previousLaunchId, "1"]) {
      act(() => router.push({ pathname: "/create", params: { prefillText: ORDER_A, prefillSession } }));
      expect((await createText()).props.value).toBe("");
    }
    fireEvent.changeText(await createText(), "Заказ B после перезапуска");
    fireEvent.press(screen.getByText("Продолжить"));
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(orderPosts()[0]).toMatchObject({ auth: "Bearer B-access", body: { text: "Заказ B после перезапуска" } });
    expect(carrying(ORDER_A)).toEqual([]);
  });

  it("повторный вход в тот же аккаунт A: новая сессия, старые данные и обработчики не работают", async () => {
    renderRouter(routes(), { initialUrl: "/orders" });
    fireEvent.changeText(await screen.findByPlaceholderText("Создать заказ"), ORDER_A);
    fireEvent.press(screen.getByLabelText("Продолжить создание заказа"));
    await waitFor(() => expect(screen.getByDisplayValue(ORDER_A)).toBeTruthy());
    const before = formDraftSession().id;
    const staleSubmit = screen.UNSAFE_getByProps({ label: "Продолжить" }).props.onPress as () => Promise<void>;
    const loggedOutAt = sent.length;
    await act(async () => { await logout(); });
    await act(async () => { await login("+70000000001", "pw-A"); });
    expect(formDraftSession().id).not.toBe(before);
    expect(screen.queryByDisplayValue(ORDER_A)).toBeNull();
    await act(async () => { await staleSubmit(); });
    await flush();
    expect(sent.slice(loggedOutAt).filter((r) => r.path === "/orders" || r.path === "/me/consents")).toEqual([]);
  });

  it("внутри одной сессии черновик из композера переживает переходы (id тот же)", async () => {
    renderRouter(routes(), { initialUrl: "/orders" });
    fireEvent.changeText(await screen.findByPlaceholderText("Создать заказ"), ORDER_A);
    fireEvent.press(screen.getByLabelText("Продолжить создание заказа"));
    await waitFor(() => expect(screen.getByDisplayValue(ORDER_A)).toBeTruthy());
    act(() => router.navigate("/profile"));
    await screen.findByPlaceholderText(/Опишите себя текстом/);
    act(() => router.navigate("/create"));
    await waitFor(() => expect(screen.getByDisplayValue(ORDER_A)).toBeTruthy());
  });
});
