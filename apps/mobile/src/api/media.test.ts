import { afterEach, expect, it, vi } from "vitest";
import { Platform } from "react-native";
import { apiClient } from "./client";
import { uploadMedia } from "./media";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("./client", () => ({ apiClient: { uploadForm: vi.fn(async () => ({ mediaId: "test" })) }, getApiBaseUrl: () => "" }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); Platform.OS = "web"; });

it("sends browser file bytes in multipart instead of stringifying the RN descriptor", async () => {
  const file = new File(["photo-content"], "avatar.png", { type: "image/png" });
  await uploadMedia("photo", { uri: "blob:local", name: file.name, type: file.type, file });
  const form = vi.mocked(apiClient.uploadForm).mock.calls[0]![1];
  expect(form.get("kind")).toBe("photo");
  const uploaded = form.get("file") as File;
  expect(uploaded.name).toBe("avatar.png");
  expect(await uploaded.text()).toBe("photo-content");
});

it("reads the local blob when the web picker supplies only a URI", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["audio"], { type: "audio/mp4" }))));
  await uploadMedia("audio", { uri: "blob:recording", name: "voice.m4a", type: "audio/mp4" });
  const form = vi.mocked(apiClient.uploadForm).mock.calls[0]![1];
  expect(await (form.get("file") as File).text()).toBe("audio");
});

// 2026-09-14: раньше native (Platform.OS !== "web") отправлял файл старым RN-
// шорткатом `{uri, name, type}` напрямую в FormData.append, без чтения через
// fetch — этот тест раньше как раз закреплял такое поведение как ожидаемое.
// На устройстве (react-native 0.86.3) это оказалось реальным багом: глобальный
// fetch больше не принимает такой дескриптор и падает с "Unsupported FormData
// part implementation" ещё до отправки запроса (см. AI_HANDOFF.md, 2026-09-14).
// Починили — native теперь тоже читает файл через fetch(uri)->blob(), как и
// web-ветка без file.file ниже. Тест обновлён под новое (правильное) поведение.
it("reads native file URIs with fetch instead of passing the raw RN descriptor", async () => {
  Platform.OS = "ios";
  vi.stubGlobal("fetch", vi.fn(async (uri: string) => {
    expect(uri).toBe("file:///avatar.jpg");
    return new Response(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
  }));
  const file = { uri: "file:///avatar.jpg", name: "avatar.jpg", type: "image/jpeg" };
  await uploadMedia("photo", file);
  expect(fetch).toHaveBeenCalledWith("file:///avatar.jpg");
  const form = vi.mocked(apiClient.uploadForm).mock.calls[0]![1];
  const uploaded = form.get("file") as File;
  expect(uploaded.name).toBe("avatar.jpg");
  expect(await uploaded.text()).toBe("jpeg-bytes");
});

// 2026-09-14 fix #2: после фикса выше запрос стал реально доходить до сервера,
// но тот отвечал invalid_mime_type даже на настоящее JPEG-фото — fetch() на
// локальном file://-URI на native не всегда кладёт верный mime в Blob.type
// (часто пусто/generic), а именно Blob.type становится Content-Type части
// multipart, по которому сервер валидирует формат. Чиним: доверяем mime,
// который уже дал сам пикер (file.type), а не то, что угадает fetch.
it("uses the picker-supplied mime type, not whatever fetch guesses for a local file", async () => {
  Platform.OS = "android";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["jpeg-bytes"], { type: "" }))));
  const file = { uri: "content://media/avatar.jpg", name: "avatar.jpg", type: "image/jpeg" };
  await uploadMedia("photo", file);
  const form = vi.mocked(apiClient.uploadForm).mock.calls[0]![1];
  const uploaded = form.get("file") as File;
  expect(uploaded.type).toBe("image/jpeg");
  expect(await uploaded.text()).toBe("jpeg-bytes");
});
