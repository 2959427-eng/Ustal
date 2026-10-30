/**
 * BLOCKER 2026-10-27: после решения в окне согласия router.replace пересоздаёт экраны вкладок, и несохранённый
 * текст профиля/заказа терялся. Реальный expo-router (Stack + Tabs + настоящие экраны) и настоящий ApiClient; сеть — fetch.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act } from "react";
import { Text, Platform } from "react-native";
import { router, Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AI_CONSENT_TEXT } from "../src/lib/ai-consent-flow";
import { readFormDraft } from "../src/lib/form-drafts";
import { login, logout } from "../src/api/auth";
import type { PickedPhoto } from "../src/components/PhotoPicker";
import { installFakeServer, type SentRequest } from "./fake-server";
import TabsLayout from "../app/(tabs)/_layout";
import ProfileScreen from "../app/(tabs)/profile";
import CreateOrderScreen from "../app/(tabs)/create";
import AiConsentScreen from "../app/ai-consent";

type Call = { url: string; method: string; body?: unknown };
const mockCalls: Call[] = [];
let mockConsents: Record<string, unknown>;
let mockFailProfile = false;

// Нативный выбор фото не нужен: PhotoPicker заменён заглушкой, которая отдаёт тесту onChange —
// так моделируется загрузка фото, завершившаяся позже (в том числе после смены сессии).
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

// Сеть — поддельный сервер на уровне fetch; ApiClient, токены и отмена запросов — настоящие.
const serve = (req: SentRequest) => {
  const { path: url, method, body } = req;
  mockCalls.push({ url, method, body });
  if (url === "/me/consents" && method === "GET") return { body: mockConsents };
  if (url === "/me/consents" && method === "POST") {
    const p = (mockConsents.policies as { id: string; policyHash: string }[])[0]!;
    const revision = (mockConsents.revision as number) + 1;
    const decision = (body as { decision: string }).decision;
    mockConsents = { ...mockConsents, revision, decisions: [{ purpose: "ai", policyId: p.id, policyHash: p.policyHash, decision, seq: revision, decidedAt: "2026-10-27T00:00:00Z", effective: decision === "grant" }] };
    return { body: { changed: true, revision } };
  }
  if (url === "/profile" && method === "GET") return { body: { profile: null, capabilities: [], resources: [], restrictions: [] } };
  if (url === "/profile/draft") return { body: { draft: null } };
  if (url === "/profile/inputs" && method === "POST") {
    if (mockFailProfile) { mockFailProfile = false; return { status: 503, body: { error: { code: "unavailable", message: "Сеть недоступна" } } }; }
    return { body: { sourceInputId: "in1", status: "queued" } };
  }
  if (url === "/orders" && method === "POST") return { status: 201, body: { orderId: "o1" } };
  if (url === "/auth/login") { const who = (body as { phone: string }).phone.endsWith("1") ? "A" : "B"; return { body: { accessToken: `${who}-access`, refreshToken: `${who}-refresh` } }; }
  if (url.startsWith("/orders/")) return { body: { id: "o1", status: "processing", moderationStatus: "pending" } };
  return { body: {} };
};

const policy = { id: "p1", purpose: "ai", version: "1", policyHash: "a".repeat(64), status: "approved", content: { humanText: "Полные условия", notice: [...AI_CONSENT_TEXT] } };
const undecided = () => ({ revision: 0, aiConsentPurpose: "ai", outboundEnforcement: true, policies: [policy], decisions: [] });
const posts = (url: string) => mockCalls.filter((c) => c.url === url && c.method === "POST");

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
  "(tabs)/orders": () => <Text>Заказы</Text>,
  "(tabs)/account": () => <Text>Аккаунт</Text>,
  "(tabs)/profile": ProfileScreen,
  "(tabs)/create": CreateOrderScreen,
  "ai-consent": AiConsentScreen,
});

let view: ReturnType<typeof renderRouter>;
const PROFILE_TEXT = "Умею класть плитку, есть перфоратор";
const profileInput = () => screen.getByPlaceholderText("Опишите себя текстом, какие у вас навыки, инструменты или транспорт");

async function fillProfileAndOpenConsent() {
  view = renderRouter(routes(), { initialUrl: "/profile" });
  fireEvent.changeText(await screen.findByPlaceholderText(/Опишите себя текстом/), PROFILE_TEXT);
  fireEvent.press(screen.getByText("Сохранить"));
  await screen.findByText("Как работает USTAL");
  expect(view.getPathname()).toBe("/ai-consent");
  expect(posts("/profile/inputs")).toHaveLength(0); // до решения в OpenAI ничего не ушло
}

beforeEach(async () => {
  mockCalls.length = 0; mockConsents = undecided(); mockFailProfile = false;
  installFakeServer(serve);
  await login("+70000000001", "pw-A"); // пользователь A
});

describe("черновик профиля переживает окно согласия (реальная навигация expo-router)", () => {
  it("разрешение: возврат в профиль с тем же текстом, без автоотправки; отправка — один раз, затем черновик очищен", async () => {
    await fillProfileAndOpenConsent();
    fireEvent.press(await screen.findByText("Разрешаю и продолжить"));
    await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    expect(await screen.findByDisplayValue(PROFILE_TEXT)).toBeTruthy();
    expect(posts("/me/consents")).toHaveLength(1);
    expect(posts("/profile/inputs")).toHaveLength(0); // нет автоматической отправки после возврата

    const save = screen.getByText("Сохранить");
    fireEvent.press(save);
    fireEvent.press(save); // двойное нажатие
    await waitFor(() => expect(posts("/profile/inputs")).toHaveLength(1));
    expect(posts("/profile/inputs")[0]!.body).toMatchObject({ inputType: "text", text: PROFILE_TEXT });
    expect(readFormDraft("profile")).toBeUndefined();
  });

  it("отказ: возврат в профиль с тем же текстом; отправка блокируется, текст сохраняется, в OpenAI ничего не уходит", async () => {
    await fillProfileAndOpenConsent();
    fireEvent.press(await screen.findByText("Не разрешаю"));
    await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    expect(await screen.findByDisplayValue(PROFILE_TEXT)).toBeTruthy();

    fireEvent.press(screen.getByText("Сохранить"));
    if (Platform.OS === "android") {
      // Android7 повторно открывает согласие только при отправке профиля после отказа.
      expect(await screen.findByText("Как работает USTAL")).toBeTruthy();
      expect(view.getPathname()).toBe("/ai-consent");
      expect(posts("/profile/inputs")).toHaveLength(0);
      fireEvent.press(screen.getByText("Не разрешаю"));
      await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    } else {
      expect(await screen.findByText(/Вы не разрешили передачу данных в OpenAI/)).toBeTruthy();
      expect(view.getPathname()).toBe("/profile");
    }
    expect(posts("/profile/inputs")).toHaveLength(0);
    expect(profileInput().props.value).toBe(PROFILE_TEXT);
    expect(readFormDraft("profile")).toBe(PROFILE_TEXT);
  });

  it("ошибка отправки после согласия — текст остаётся; черновик не попадает в URL", async () => {
    await fillProfileAndOpenConsent();
    expect(JSON.stringify(view.getSearchParams())).not.toContain(PROFILE_TEXT);
    fireEvent.press(await screen.findByText("Разрешаю и продолжить"));
    await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    mockFailProfile = true;
    fireEvent.press(await screen.findByText("Сохранить"));
    expect(await screen.findByText("Сеть недоступна")).toBeTruthy();
    expect(profileInput().props.value).toBe(PROFILE_TEXT);
    expect(readFormDraft("profile")).toBe(PROFILE_TEXT);
    expect(mockCalls.every((c) => !c.url.includes(encodeURIComponent(PROFILE_TEXT)))).toBe(true);
  });
});

describe("черновик нового заказа переживает окно согласия", () => {
  it("заказ до согласия: окно, отказ → профиль; при возврате к заказу текст и цена на месте, заказ не создан", async () => {
    view = renderRouter(routes(), { initialUrl: "/create" });
    fireEvent.changeText(await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами"), "Покрасить забор");
    fireEvent.changeText(screen.getByPlaceholderText("Например, 2000"), "3000");
    fireEvent.press(screen.getByText("Продолжить"));
    if (Platform.OS === "android") {
      await waitFor(() => expect(view.getPathname()).toBe("/profile"));
      expect(screen.queryByText("Как работает USTAL")).toBeNull();
      expect(posts("/orders")).toHaveLength(0);
      fireEvent.changeText(await screen.findByPlaceholderText(/Опишите себя текстом/), PROFILE_TEXT);
      fireEvent.press(screen.getByText("Сохранить"));
    }
    await screen.findByText("Как работает USTAL");
    fireEvent.press(await screen.findByText("Не разрешаю"));
    await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    expect(posts("/orders")).toHaveLength(0);

    router.navigate("/create");
    expect(await screen.findByDisplayValue("Покрасить забор")).toBeTruthy();
    expect(screen.getByDisplayValue("3000")).toBeTruthy();
    expect(readFormDraft("order")).toMatchObject({ text: "Покрасить забор", priceText: "3000" });
  });

  it("после согласия заказ создаётся один раз и черновик очищается", async () => {
    mockConsents = { ...undecided(), revision: 1, decisions: [{ purpose: "ai", policyId: "p1", policyHash: policy.policyHash, decision: "grant", seq: 1, decidedAt: "2026-10-27T00:00:00Z", effective: true }] };
    view = renderRouter(routes(), { initialUrl: "/create" });
    fireEvent.changeText(await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами"), "Покрасить забор");
    const next = screen.getByText("Продолжить");
    fireEvent.press(next);
    fireEvent.press(next); // двойное нажатие
    await waitFor(() => expect(posts("/orders")).toHaveLength(1));
    expect(readFormDraft("order")).toBeUndefined();
  });
});

describe("смена сессии: поздние обработчики старого экрана не передают черновик следующему пользователю", () => {
  const photoA = { mediaId: "media-A", uri: "file:///a.jpg" } as unknown as PickedPhoto;

  it("заказ: старый экран → logout → поздняя запись текста, цены и фото → login B — у B пустая форма", async () => {
    view = renderRouter(routes(), { initialUrl: "/create" });
    const oldText = await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами");
    const oldPrice = screen.getByPlaceholderText("Например, 2000");
    fireEvent.changeText(oldText, "Заказ пользователя A");
    fireEvent.changeText(oldPrice, "5000");
    const oldOnChange = mockPhotoPicker.props!.onChange;
    act(() => oldOnChange([photoA]));
    expect(readFormDraft("order")).toMatchObject({ text: "Заказ пользователя A", priceText: "5000", photos: [photoA] });

    await act(async () => { await logout(); });
    fireEvent.changeText(oldText, "Поздний текст A");
    fireEvent.changeText(oldPrice, "9999");
    act(() => oldOnChange([photoA])); // загрузка фото завершилась после выхода
    await act(async () => { await login("+70000000002", "pw-B"); });
    act(() => oldOnChange([photoA])); // …или уже после входа B

    expect(readFormDraft("order")).toBeUndefined();
    for (const v of ["Заказ пользователя A", "Поздний текст A", "5000", "9999"]) expect(screen.queryByDisplayValue(v)).toBeNull();
    expect(mockPhotoPicker.props!.photos).toEqual([]);

    view.unmount();
    view = renderRouter(routes(), { initialUrl: "/create" });
    expect((await screen.findByPlaceholderText("Опишите, что нужно сделать — своими словами")).props.value).toBe("");
    expect(screen.getByPlaceholderText("Например, 2000").props.value).toBe("");
    expect(mockPhotoPicker.props!.photos).toEqual([]);
    expect(posts("/orders")).toHaveLength(0);
  });

  it("профиль: старый экран → logout → поздний ввод → login B — у B пустое поле, черновика нет", async () => {
    view = renderRouter(routes(), { initialUrl: "/profile" });
    const oldInput = await screen.findByPlaceholderText(/Опишите себя текстом/);
    fireEvent.changeText(oldInput, "Профиль пользователя A");
    await act(async () => { await logout(); });
    fireEvent.changeText(oldInput, "Поздний профиль A");
    await act(async () => { await login("+70000000002", "pw-B"); });
    expect(readFormDraft("profile")).toBeUndefined();
    expect(screen.queryByDisplayValue("Профиль пользователя A")).toBeNull();
    expect(screen.queryByDisplayValue("Поздний профиль A")).toBeNull();

    view.unmount();
    view = renderRouter(routes(), { initialUrl: "/profile" });
    expect((await screen.findByPlaceholderText(/Опишите себя текстом/)).props.value).toBe("");
    expect(posts("/profile/inputs")).toHaveLength(0);
  });

  it("в одной сессии черновик по-прежнему переживает окно согласия (после смены сессии)", async () => {
    await act(async () => { await login("+70000000002", "pw-B"); });
    await fillProfileAndOpenConsent();
    fireEvent.press(await screen.findByText("Не разрешаю"));
    await waitFor(() => expect(view.getPathname()).toBe("/profile"));
    expect(await screen.findByDisplayValue(PROFILE_TEXT)).toBeTruthy();
  });
});
