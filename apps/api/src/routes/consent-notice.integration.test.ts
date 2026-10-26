import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql } from "@ustal/database";
import consentRoutes from "./consents.js";
import { disclosureHash } from "../lib/consents.js";
// Копия утверждённого текста окна (apps/mobile/src/lib/ai-consent-flow.ts, AI_CONSENT_TEXT): сервер принимает grant только на него.
const AI_CONSENT_TEXT = [
  "USTAL использует искусственный интеллект OpenAI, чтобы понимать ваши навыки и ресурсы, анализировать заказы и находить подходящие предложения.",
  "Для этого необходимые данные профиля, тексты заказов и голосовые записи могут передаваться OpenAI для обработки.",
  "Подробнее — в Политике конфиденциальности.",
  "Нажимая «Разрешаю и продолжить», вы даёте разрешение на такую обработку и передачу данных. Разрешение можно отозвать, но без него основные функции USTAL будут недоступны.",
];

assertLocalTestDatabase();
const db = getSql();
const app = Fastify();
const purpose = `notice-test-${randomUUID()}`, legacyPurpose = `notice-legacy-${randomUUID()}`;
const notice = [...AI_CONSENT_TEXT];
const content = { humanText: "TEST FIXTURE: полные условия", notice, aiDispatch: {} };
const legacyContent = { humanText: "TEST FIXTURE: условия без уведомления", aiDispatch: {} };
const hash = disclosureHash(content), legacyHash = disclosureHash(legacyContent);
let policy = randomUUID();
const legacy = randomUUID();

const user = async () => {
  const id = randomUUID();
  await db`INSERT INTO users(id, phone, password_hash) VALUES (${id}, ${`test_${id.slice(0, 12)}`}, 'test')`;
  return id;
};
const post = (userId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/me/consents", headers: { "x-test-user": userId }, payload });
const body = (over: Record<string, unknown> = {}) =>
  ({ policyId: policy, policyHash: hash, policyVersion: "v1", notice, decision: "grant", expectedRevision: 0, ...over });
const rows = async (userId: string) => db`SELECT decision, policy_id, policy_hash FROM consent_decisions WHERE user_id=${userId} ORDER BY seq`;
const code = (res: { json: () => any }) => res.json().error?.code;

beforeAll(async () => {
  vi.stubEnv("USTAL_AI_CONSENT_MODE", "enforced");
  await db`INSERT INTO consent_disclosures(id, purpose, version, content, content_hash, status, is_current)
    VALUES (${policy}, ${purpose}, 'v1', ${db.json(content)}, ${hash}, 'approved', true),
    (${legacy}, ${legacyPurpose}, 'legacy-1', ${db.json(legacyContent)}, ${legacyHash}, 'approved', true)`;
  app.decorateRequest("userId", "");
  app.decorate("authenticate", async (request: any, reply: any) => {
    const id = request.headers["x-test-user"];
    if (!id) return reply.code(401).send({ error: { code: "unauthorized" } });
    request.userId = id;
  });
  await app.register(consentRoutes);
});
afterAll(async () => { vi.unstubAllEnvs(); await app.close(); await db.end(); });

describe("grant привязан к показанному уведомлению и текущей утверждённой версии", () => {
  it("совпадение текста и версии — согласие записано по этой политике; повторный запрос — no-op", async () => {
    const u = await user();
    const res = await post(u, body());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: true, revision: 1 });
    expect(await rows(u)).toEqual([{ decision: "grant", policy_id: policy, policy_hash: hash }]);
    const again = await post(u, body({ expectedRevision: 1 }));
    expect(again.json()).toEqual({ changed: false, revision: 1 });
    expect(await rows(u)).toHaveLength(1);
  });

  it("текст не совпадает (символ, абзац, порядок) или не прислан — 409, решения нет", async () => {
    const u = await user();
    for (const n of [[notice[0] + " ", ...notice.slice(1)], notice.slice(0, 3), [...notice].reverse(), [notice[0]!.replace("OpenAI", "X"), ...notice.slice(1)], undefined]) {
      const res = await post(u, body({ notice: n }));
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe("consent_notice_mismatch");
    }
    expect(await rows(u)).toHaveLength(0);
  });

  it("подмена версии или отсутствие версии — 409, решения нет", async () => {
    const u = await user();
    expect(code(await post(u, body({ policyVersion: "v0" })))).toBe("consent_policy_changed");
    expect(code(await post(u, body({ policyVersion: undefined })))).toBe("consent_notice_mismatch");
    expect(await rows(u)).toHaveLength(0);
  });

  it("политики нет или у неё нет утверждённого уведомления — grant с текстом окна отклоняется", async () => {
    const u = await user();
    expect(code(await post(u, body({ policyId: randomUUID() })))).toBe("consent_policy_changed");
    expect(code(await post(u, body({ policyId: legacy, policyHash: legacyHash, policyVersion: "legacy-1" })))).toBe("consent_notice_mismatch");
    expect(await rows(u)).toHaveLength(0);
  });

  it("лишние поля и слишком большой текст — 400", async () => {
    const u = await user();
    expect((await post(u, body({ noticeHash: "x" }))).statusCode).toBe(400);
    expect((await post(u, body({ notice: Array(21).fill("a") }))).statusCode).toBe(400);
    expect((await post(u, body({ notice: ["a".repeat(4001)] }))).statusCode).toBe(400);
  });

  it("старый клиент: grant без текста по политике без уведомления работает как раньше (хеш содержимого)", async () => {
    const u = await user();
    const res = await post(u, { policyId: legacy, policyHash: legacyHash, decision: "grant", expectedRevision: 0 });
    expect(res.json()).toEqual({ changed: true, revision: 1 });
  });

  it("отказ: revoke с версией сохраняется без текста; чужая версия — 409; старый клиент без версии — как раньше", async () => {
    const u = await user();
    expect(code(await post(u, body({ decision: "revoke", notice: undefined, policyVersion: "v9" })))).toBe("consent_policy_changed");
    expect((await post(u, body({ decision: "revoke", notice: undefined }))).json()).toEqual({ changed: true, revision: 1 });
    const v = await user();
    expect((await post(v, { policyId: policy, policyHash: hash, decision: "revoke", expectedRevision: 0 })).json()).toEqual({ changed: true, revision: 1 });
    expect(await rows(u)).toEqual([{ decision: "revoke", policy_id: policy, policy_hash: hash }]);
  });

  it("отзыв: после grant revoke записывается; в режиме off отзыв работает, а grant — нет", async () => {
    const u = await user();
    await post(u, body());
    vi.stubEnv("USTAL_AI_CONSENT_MODE", "off");
    try {
      expect(code(await post(u, body({ expectedRevision: 1 })))).toBe("consent_enforcement_inactive");
      expect((await post(u, body({ decision: "revoke", notice: undefined, expectedRevision: 1 }))).json()).toEqual({ changed: true, revision: 2 });
    } finally { vi.stubEnv("USTAL_AI_CONSENT_MODE", "enforced"); }
    expect((await rows(u)).map(r => r.decision)).toEqual(["grant", "revoke"]);
  });

  it("гонка: два одновременных grant — одно решение; параллельная смена версии — grant по старой отклоняется", async () => {
    const u = await user();
    const results = await Promise.all([post(u, body()), post(u, body())]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(await rows(u)).toHaveLength(1);

    const w = await user();
    const next = randomUUID(), nextContent = { ...content, humanText: "TEST FIXTURE: новые условия" }, nextHash = disclosureHash(nextContent);
    // Пользователь читает v1, в это время публикуется v2.
    await db.begin(async tx => {
      await tx`UPDATE consent_disclosures SET is_current=false WHERE id=${policy}`;
      await tx`INSERT INTO consent_disclosures(id, purpose, version, content, content_hash, status, is_current)
        VALUES (${next}, ${purpose}, 'v2', ${tx.json(nextContent)}, ${nextHash}, 'approved', true)`;
    });
    expect(code(await post(w, body()))).toBe("consent_policy_not_approved_current");
    expect(code(await post(w, body({ policyId: next, policyHash: hash, policyVersion: "v2" })))).toBe("consent_policy_changed");
    expect(code(await post(w, body({ policyId: next, policyHash: nextHash, policyVersion: "v1" })))).toBe("consent_policy_changed");
    expect(await rows(w)).toHaveLength(0);
    expect((await post(w, body({ policyId: next, policyHash: nextHash, policyVersion: "v2" }))).json()).toEqual({ changed: true, revision: 1 });
    policy = next;
  });
});
