import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("@aws-sdk/client-s3", async (orig) => {
  const real = await orig<typeof import("@aws-sdk/client-s3")>();
  return { ...real, S3Client: class { send(cmd: unknown) { sent.push(cmd); return Promise.resolve({}); } } };
});
const { createLocalDiskStorage } = await import("./providers/local-disk.js");
const { createS3Storage } = await import("./providers/s3.js");
const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

describe("media removal (account deletion, 2026-10-19)", () => {
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
});
