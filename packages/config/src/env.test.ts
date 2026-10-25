import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://ustal:ustal@localhost:5432/ustal_test",
  JWT_ACCESS_SECRET: "test-access-secret-0123456789",
  JWT_REFRESH_SECRET: "test-refresh-secret-0123456789",
} as NodeJS.ProcessEnv;

describe("loadEnv: .env.example copied as-is must start", () => {
  it("treats an empty OPENAI_BASE_URL (\"OPENAI_BASE_URL=\") as not set", () => {
    expect(loadEnv({ ...base, OPENAI_BASE_URL: "" }).OPENAI_BASE_URL).toBeUndefined();
  });
  it("still rejects a non-empty invalid OPENAI_BASE_URL", () => {
    expect(() => loadEnv({ ...base, OPENAI_BASE_URL: "not a url" })).toThrow(/OPENAI_BASE_URL/);
  });
  it("still requires OPENAI_BASE_URL in production with AI_PROVIDER=openai", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", AI_PROVIDER: "openai", OPENAI_BASE_URL: "" })).toThrow(/OPENAI_BASE_URL/);
  });
});

const production = {
  ...base, NODE_ENV: "production", AI_PROVIDER: "openai",
  DATABASE_URL: "postgres://ustal:fixture-only-strong-db-pass@db:5432/ustal",
  JWT_ACCESS_SECRET: "fixture-access-012345678901234567890123",
  JWT_REFRESH_SECRET: "fixture-refresh-01234567890123456789012",
  ADMIN_SESSION_SECRET: "fixture-admin-0123456789012345678901234",
  OPENAI_API_KEY: "fixture-relay-token-01234567890123456789", OPENAI_BASE_URL: "https://relay.ustal.invalid/v1",
  MEDIA_STORAGE_PROVIDER: "s3", OBJECT_STORAGE_ENDPOINT: "https://s3.ustal.invalid",
  OBJECT_STORAGE_BUCKET: "ustal-media", OBJECT_STORAGE_ACCESS_KEY: "fixture-access",
  OBJECT_STORAGE_SECRET_KEY: "fixture-storage-secret",
};
describe("production startup guard", () => {
  it("accepts a complete relay and S3 configuration without network calls", () => {
    expect(loadEnv(production).AI_PROVIDER).toBe("openai");
  });
  it.each([
    ["AI_PROVIDER", "mock"], ["JWT_ACCESS_SECRET", "change-me-access-secret-0123456789"],
    ["JWT_REFRESH_SECRET", production.JWT_ACCESS_SECRET], ["ADMIN_SESSION_SECRET", ""],
    ["OPENAI_API_KEY", ""], ["OPENAI_API_KEY", "sk-fixture-direct-key-01234567890123456789"],
    ["OBJECT_STORAGE_ENDPOINT", "https://"], ["OPENAI_BASE_URL", "https://"], ["DATABASE_URL", "postgres://%"], ["OPENAI_BASE_URL", "https://api.openai.com/v1"],
    ["OPENAI_BASE_URL", "http://relay.ustal.invalid/v1"], ["MEDIA_STORAGE_PROVIDER", "local"],
    ["OBJECT_STORAGE_SECRET_KEY", "<SET_ME>"], ["DATABASE_URL", base.DATABASE_URL!],
    ["PHONE_VERIFICATION_MODE", "required_for_new"],
  ])("rejects unsafe %s", (key, value) => {
    expect(() => loadEnv({ ...production, [key]: value })).toThrow("Invalid environment configuration");
  });
});

describe("explicit consent worker configuration",()=>{
 it("defaults off and accepts an empty optional purpose without fabricating one",()=>{expect(loadEnv({...base,USTAL_AI_CONSENT_PURPOSE:""}).USTAL_AI_CONSENT_MODE).toBe("off");expect(loadEnv({...base,USTAL_AI_CONSENT_PURPOSE:""}).USTAL_AI_CONSENT_PURPOSE).toBeUndefined();});
 it("rejects invalid mode/purpose and preserves explicit enforced configuration",()=>{expect(()=>loadEnv({...base,USTAL_AI_CONSENT_MODE:"yes"})).toThrow();expect(()=>loadEnv({...base,USTAL_AI_CONSENT_PURPOSE:"bad purpose"})).toThrow();expect(loadEnv({...base,USTAL_AI_CONSENT_MODE:"enforced",USTAL_AI_CONSENT_PURPOSE:"synthetic-purpose"}).USTAL_AI_CONSENT_MODE).toBe("enforced");});
});

describe("staged registration age self-declaration", () => {
 it("preserves old registration by default", () => expect(loadEnv(base).USTAL_REGISTRATION_AGE_MODE).toBe("compatibility"));
 it("accepts explicit required rollout", () => expect(loadEnv({ ...base, USTAL_REGISTRATION_AGE_MODE: "required" }).USTAL_REGISTRATION_AGE_MODE).toBe("required"));
 it("rejects an invalid rollout mode", () => expect(() => loadEnv({ ...base, USTAL_REGISTRATION_AGE_MODE: "enforce-ish" })).toThrow(/USTAL_REGISTRATION_AGE_MODE/));
});
