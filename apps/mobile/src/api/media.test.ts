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

it("preserves the native multipart descriptor without reading file URIs with fetch", async () => {
  Platform.OS = "ios";
  const append = vi.fn();
  vi.stubGlobal("FormData", class { append = append; });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const file = { uri: "file:///avatar.jpg", name: "avatar.jpg", type: "image/jpeg" };
  await uploadMedia("photo", file);
  expect(append).toHaveBeenCalledWith("file", file);
  expect(fetchMock).not.toHaveBeenCalled();
});
