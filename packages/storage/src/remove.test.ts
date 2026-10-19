import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as unknown[]);
const pending = vi.hoisted(() => ({ enabled: false }));
vi.mock("@aws-sdk/client-s3", async (orig) => {
  const real = await orig<typeof import("@aws-sdk/client-s3")>();
  return { ...real, S3Client: class { send(cmd: unknown, options?: { abortSignal?: AbortSignal }) {
    sent.push(cmd);
    if (pending.enabled) return new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    return Promise.resolve({});
  } } };
});
const { createLocalDiskStorage } = await import("./providers/local-disk.js");
const { createS3Storage } = await import("./providers/s3.js");
const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

describe("media removal (account deletion, 2026-10-19)", () => {
  it("cleanup identity separates storage namespaces and survives credential rotation", () => {
    const config = { endpoint: "https://s3.example", bucket: "a", accessKeyId: "old-key", secretAccessKey: "old-secret" };
    const first = createS3Storage(config).cleanupIdentity;
    expect(createS3Storage({ ...config, accessKeyId: "new-key", secretAccessKey: "new-secret" }).cleanupIdentity).toBe(first);
    expect(createS3Storage({ ...config, bucket: "b" }).cleanupIdentity).not.toBe(first);
    expect(createS3Storage({ ...config, endpoint: "https://other.example" }).cleanupIdentity).not.toBe(first);
    expect(first).not.toContain("old-key"); expect(first).not.toContain("s3.example");
    expect(createLocalDiskStorage(path.resolve("media-a")).cleanupIdentity).toBe(createLocalDiskStorage("media-a").cleanupIdentity);
    expect(createLocalDiskStorage("media-b").cleanupIdentity).not.toBe(createLocalDiskStorage("media-a").cleanupIdentity);
  });

  it("local: removes the file, a missing file is fine, never leaves the media dir", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "media-"));
    const storage = createLocalDiskStorage(base);
    const key = "photo/u1/a.jpg";
    await mkdir(path.join(base, "photo/u1"), { recursive: true });
    await writeFile(path.join(base, key), "x");
    await storage.remove(key);
    await expect(access(path.join(base, key))).rejects.toThrow();
    await expect(storage.remove(key)).resolves.toBeUndefined();
    await expect(storage.remove("../outside.txt")).rejects.toThrow("Invalid storage key");
    await expect(storage.remove("/etc/passwd")).rejects.toThrow("Invalid storage key");
  });
  it("s3: sends DeleteObject for the exact key and bucket", async () => {
    const storage = createS3Storage({ endpoint: "https://s3.example", bucket: "b", accessKeyId: "k", secretAccessKey: "s" });
    await storage.remove("photo/u1/a.jpg");
    const cmd = sent.at(-1) as InstanceType<typeof DeleteObjectCommand>;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: "b", Key: "photo/u1/a.jpg" });
  });
  it("s3: a stalled DeleteObject receives a bounded abort signal", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    pending.enabled = true;
    try {
      const storage = createS3Storage({ endpoint: "https://s3.example", bucket: "b", accessKeyId: "k", secretAccessKey: "s" });
      const deletion = storage.remove("photo/u1/a.jpg");
      const rejected = expect(deletion).rejects.toMatchObject({ name: "AbortError" });
      expect(timeout).toHaveBeenCalledWith(10_000);
      controller.abort();
      await rejected;
    } finally { pending.enabled = false; timeout.mockRestore(); }
  });
});
