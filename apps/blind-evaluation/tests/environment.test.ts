import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLiveAiEnvironment, safeEnvironmentError } from "../src/environment.js";
const valid = { AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://relay.invalid/v1", OPENAI_API_KEY: "fixture-relay-token" };
describe("blind live environment", () => {
  it("accepts configured relay", () => assert.doesNotThrow(() => assertLiveAiEnvironment(valid)));
  for (const key of Object.keys(valid)) it(`rejects missing ${key} without revealing values`, () => {
    assert.throws(() => assertLiveAiEnvironment({ ...valid, [key]: "" }), new RegExp(key));
  });
  it("rejects mock and malformed URL", () => {
    assert.throws(() => assertLiveAiEnvironment({ ...valid, AI_PROVIDER: "mock" }), /AI_PROVIDER/);
    assert.throws(() => assertLiveAiEnvironment({ ...valid, OPENAI_BASE_URL: "invalid" }), /OPENAI_BASE_URL/);
  });
  it("redacts relay tokens in errors", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-relay-token";
    try { assert.equal(safeEnvironmentError(new Error("401 fixture-relay-token")), "401 [REDACTED]"); }
    finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  });
});
