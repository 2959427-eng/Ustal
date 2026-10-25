import { describe, expect, it } from "vitest";
import { registerSchema } from "./auth.js";
const base = { name: "Test", phone: "+79991234567", password: "password123", cityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", acceptedRules: true, acceptedPdn: true };
describe("registration age compatibility", () => {
 it("accepts an explicit adult self-declaration", () => expect(registerSchema.parse({ ...base, acceptedAge18: true }).acceptedAge18).toBe(true));
 it("rejects false and coerced/string confirmations", () => { for (const acceptedAge18 of [false, "true", 1, null]) expect(registerSchema.safeParse({ ...base, acceptedAge18 }).success).toBe(false); });
 it("keeps old clients compatible without inventing age evidence", () => expect(registerSchema.parse(base).acceptedAge18).toBeUndefined());
});
