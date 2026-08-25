import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getMediaStorage() и loadEnv() (@ustal/config) кешируют своё состояние на
 * уровне модуля — vi.resetModules() + динамический import() в каждом тесте
 * даёт каждому сценарию свежий модульный граф, иначе первый вызов loadEnv()
 * в процессе "запечатывает" env для всех последующих тестов.
 */
const BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
};

describe("getMediaStorage", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("MEDIA_STORAGE_PROVIDER=s3 без OBJECT_STORAGE_* бросает явную ошибку со списком отсутствующих переменных", async () => {
    Object.assign(process.env, BASE_ENV, { MEDIA_STORAGE_PROVIDER: "s3" });
    const { getMediaStorage } = await import("./index.js");
    expect(() => getMediaStorage()).toThrowError(
      /OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY, OBJECT_STORAGE_SECRET_KEY/,
    );
  });

  it("MEDIA_STORAGE_PROVIDER=s3 с частично заданными OBJECT_STORAGE_* перечисляет только отсутствующие", async () => {
    Object.assign(process.env, BASE_ENV, {
      MEDIA_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.timeweb.cloud",
    });
    const { getMediaStorage } = await import("./index.js");
    try {
      getMediaStorage();
      expect.unreachable("должно было бросить");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("OBJECT_STORAGE_ACCESS_KEY");
      expect(message).toContain("OBJECT_STORAGE_SECRET_KEY");
      expect(message).not.toContain("OBJECT_STORAGE_ENDPOINT,"); // не отсутствует — не должен быть в списке
    }
  });

  it("MEDIA_STORAGE_PROVIDER=s3 со всеми OBJECT_STORAGE_* создаёт провайдер без сетевого вызова", async () => {
    Object.assign(process.env, BASE_ENV, {
      MEDIA_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.timeweb.cloud",
      OBJECT_STORAGE_ACCESS_KEY: "fake-access-key",
      OBJECT_STORAGE_SECRET_KEY: "fake-secret-key",
    });
    const { getMediaStorage } = await import("./index.js");
    const storage = getMediaStorage();
    expect(storage.name).toBe("s3");
  });

  it("MEDIA_STORAGE_PROVIDER не задан (по умолчанию local) не требует OBJECT_STORAGE_*", async () => {
    Object.assign(process.env, BASE_ENV);
    const { getMediaStorage } = await import("./index.js");
    const storage = getMediaStorage();
    expect(storage.name).toBe("local");
  });
});
