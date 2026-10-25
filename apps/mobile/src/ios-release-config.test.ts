import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const configure = require("../app.config.js");
const base = require("../app.json").expo;
const eas = require("../eas.json");

afterEach(() => vi.unstubAllEnvs());

function release() {
  vi.stubEnv("EAS_BUILD_PROFILE", "production");
  vi.stubEnv("USTAL_API_URL", eas.build.production.env.USTAL_API_URL);
  vi.stubEnv("EAS_PROJECT_ID", "");
  return configure({ config: structuredClone(base) });
}

describe("iOS TestFlight release configuration", () => {
  it("builds the linked store app identity without a CLI-only project override", () => {
    const config = release();
    expect(config.version).toBe("1.0.0");
    expect(config.ios.bundleIdentifier).toBe("ru.ustal.app");
    expect(config.owner).toBe("kimkos1980");
    expect(config.extra.eas.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(config.extra.release).toBe(true);
    expect(config.extra.apiBaseUrl).toBe("https://api.ustal.site");
  });

  it("lets EAS own the build number and production store distribution", () => {
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(eas.build.production.autoIncrement).toBe(true);
    expect(eas.build.production.distribution).toBe("store");
    expect(eas.build.production.ios.simulator).toBe(false);
  });

  it("declares only used permissions with specific Russian purpose strings", () => {
    const plist = base.ios.infoPlist;
    expect(Object.keys(plist).filter((key) => key.endsWith("UsageDescription")).sort())
      .toEqual(["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryUsageDescription"]);
    expect(plist.NSCameraUsageDescription).toMatch(/заказ.*профил/);
    expect(plist.NSPhotoLibraryUsageDescription).toMatch(/заказ.*профил/);
    expect(plist.NSMicrophoneUsageDescription).toMatch(/надиктовать/);
    // expo-secure-store would otherwise inject an unused English Face ID prompt.
    expect(base.plugins).toContainEqual(["expo-secure-store", { faceIDPermission: false }]);
  });

  it("answers export compliance and declares required-reason APIs without tracking", () => {
    expect(base.ios.config.usesNonExemptEncryption).toBe(false);
    const manifest = base.ios.privacyManifests;
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    const reasons = Object.fromEntries(manifest.NSPrivacyAccessedAPITypes.map(
      (entry: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }) =>
        [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons]));
    expect(reasons).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"],
      NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1"],
      NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1"],
    });
  });
});
