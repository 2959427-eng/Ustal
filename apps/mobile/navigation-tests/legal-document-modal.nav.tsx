/**
 * Юридические документы открываются во встроенном окне поверх экрана (настоящие expo-router, Modal, Safe Area):
 * заголовок, ✕, прокрутка, «Закрыть», системная «Назад» (onRequestClose); введённые данные экрана сохраняются;
 * в Safari/Chrome (Linking.openURL) ничего не уходит. Сеть — поддельный fetch с HTML серверной страницы.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, useState } from "react";
import { Linking, Modal, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LegalLink, LegalLinks } from "../src/components/LegalLinks";
import { legalLinks } from "../src/lib/legal-links";

jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));

const PAGE = (title: string) => `<!doctype html><html><body><main><h1>USTAL — ${title}</h1><h2>Данные аккаунта</h2><p>Полный текст «документа» &amp; &quot;условия&quot;.</p>`
  + `<form id="login-form"><h2>1. Войдите в свой аккаунт</h2></form><footer><p>Контакт: support@ustal.site</p><p>Версия 2026-10-26. Действует с 2026-10-26.</p></footer></main></body></html>`;
const requests: { url: string; init: RequestInit }[] = [];
let failNext = false;

function Form() {
  const [name, setName] = useState("");
  return (
    <View>
      <TextInput placeholder="Имя" value={name} onChangeText={setName} />
      <LegalLinks />
      <LegalLink page="terms" label="Открыть пользовательское соглашение" />
    </View>
  );
}
const routes = { _layout: () => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}><Stack /></SafeAreaProvider>, index: Form };

beforeEach(() => {
  requests.length = 0; failNext = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    if (failNext) { failNext = false; return { ok: false, status: 503, text: async () => "" } as Response; }
    const title = String(url).endsWith("/terms") ? "Пользовательское соглашение" : "Политика конфиденциальности";
    return { ok: true, status: 200, text: async () => PAGE(title) } as Response;
  }) as typeof fetch;
});
const visibleModals = () => screen.UNSAFE_getAllByType(Modal).filter((m) => m.props.visible);

describe("юридические документы — встроенное окно", () => {
  it.each(legalLinks.map(([page, label]) => ({ page, label })))("$page: all documents open inside the app and preserve the form", async ({ page, label }) => {
    renderRouter(routes, { initialUrl: "/" });
    fireEvent.changeText(screen.getByPlaceholderText("Имя"), "Filled form");
    fireEvent.press(screen.getByText(label));
    await screen.findByText("Данные аккаунта");
    expect(requests[0]!.url).toBe(`https://api.ustal.test/${page}`);
    fireEvent.press(screen.getByLabelText("Закрыть документ"));
    expect(screen.getByDisplayValue("Filled form")).toBeTruthy();
  });

  it("closing cancels the request; a late old response cannot replace the next document", async () => {
    let release!: (r: Response) => void;
    globalThis.fetch = jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
    renderRouter(routes, { initialUrl: "/" });
    fireEvent.press(screen.getByText("Конфиденциальность"));
    const init = (globalThis.fetch as jest.Mock).mock.calls[0]![1] as RequestInit;
    fireEvent.press(screen.getByLabelText("Закрыть документ"));
    expect(init.signal!.aborted).toBe(true);
    globalThis.fetch = jest.fn(async () => ({ ok: true, text: async () => PAGE("NEW") } as Response)) as typeof fetch;
    fireEvent.press(screen.getByText("Поддержка"));
    await screen.findByText("USTAL — NEW");
    await act(async () => { release({ ok: true, text: async () => PAGE("OLD") } as Response); });
    expect(screen.queryByText("USTAL — OLD")).toBeNull();
  });

  it("открывается поверх экрана: заголовок, полный текст и версия с сервера, ✕ закрывает; введённое имя на месте", async () => {
    const openURL = jest.spyOn(Linking, "openURL");
    renderRouter(routes, { initialUrl: "/" });
    fireEvent.changeText(screen.getByPlaceholderText("Имя"), "Дмитрий");
    fireEvent.press(screen.getByText("Конфиденциальность"));
    expect(await screen.findByText("USTAL — Политика конфиденциальности")).toBeTruthy();
    expect(screen.getByText("Полный текст «документа» & \"условия\".")).toBeTruthy();
    expect(screen.getByText("Версия 2026-10-26. Действует с 2026-10-26.")).toBeTruthy();
    expect(screen.queryByText("1. Войдите в свой аккаунт")).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://api.ustal.test/privacy", init: { credentials: "omit" } });
    fireEvent.press(screen.getByLabelText("Закрыть документ"));
    expect(visibleModals()).toHaveLength(0);
    expect(screen.getByDisplayValue("Дмитрий")).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("кнопка «Закрыть» и системная «Назад» Android (onRequestClose) закрывают окно без перехода", async () => {
    renderRouter(routes, { initialUrl: "/" });
    fireEvent.press(screen.getByText("Открыть пользовательское соглашение"));
    expect(await screen.findByText("USTAL — Пользовательское соглашение")).toBeTruthy();
    fireEvent.press(screen.getByText("Закрыть"));
    expect(visibleModals()).toHaveLength(0);

    fireEvent.press(screen.getByText("Пользовательское соглашение"));
    await screen.findByText("USTAL — Пользовательское соглашение");
    act(() => { (visibleModals()[0]!.props.onRequestClose as () => void)(); });
    expect(visibleModals()).toHaveLength(0);
    expect(screen.getByPlaceholderText("Имя")).toBeTruthy();
  });

  it("сервер недоступен — понятная ошибка и «Повторить»; документ не подменяется локальной копией", async () => {
    failNext = true;
    renderRouter(routes, { initialUrl: "/" });
    fireEvent.press(screen.getByText("Правила сообщества"));
    expect(await screen.findByText(/Не удалось загрузить документ/)).toBeTruthy();
    expect(screen.queryByText("Данные аккаунта")).toBeNull();
    fireEvent.press(screen.getByText("Повторить"));
    await waitFor(() => expect(screen.getByText("Данные аккаунта")).toBeTruthy());
    expect(requests.map((r) => r.url)).toEqual(["https://api.ustal.test/community-guidelines", "https://api.ustal.test/community-guidelines"]);
  });

  it("каждое открытие загружает действующий документ заново (без устаревшей копии)", async () => {
    renderRouter(routes, { initialUrl: "/" });
    for (let i = 0; i < 2; i++) {
      fireEvent.press(screen.getByText("Поддержка"));
      await screen.findByText("Данные аккаунта");
      fireEvent.press(screen.getByText("Закрыть"));
    }
    expect(requests).toHaveLength(2);
  });
});
