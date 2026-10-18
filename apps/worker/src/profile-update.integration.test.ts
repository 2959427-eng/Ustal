import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR as SEP, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { evaluateSemantic } from "@ustal/matching";
import { prepareDocument, prepareProfileFromMessages, profileItemsOf, type PreparedDocument } from "./semantic.js";
import { isRevokedCapability } from "./profile-negatives.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

/**
 * Обновление профиля по одному сообщению (2026-10-13): состояние применённого профиля + только новое сообщение.
 * Ответ нормализации подставлен (факты нового сообщения и removes), остальное — настоящий prepareDocument.
 */
const fact = (o: Record<string, unknown>) => ({
  kind: "capability", subjectType: "unspecified", canonicalKeys: [], confidence: 0.95, mandatory: false, constraintType: "none",
  constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, ...o,
});
const seen: { text: string; items?: unknown }[] = [];
function mockNormalization(answer: (text: string) => { facts: Record<string, unknown>[]; removes?: (doc: PreparedDocument) => string[] }, prior?: PreparedDocument) {
  return vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    seen.push({ text: input.text, items: input.profileItems });
    const a = answer(input.text);
    return { data: { facts: a.facts.map(fact), ...(prior && a.removes ? { removes: a.removes(prior) } : {}) },
      provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } as never;
  });
}
async function first(text: string, facts: Record<string, unknown>[]) {
  const spy = mockNormalization(() => ({ facts }));
  try { return await prepareDocument("profile", text, {}, randomUUID()); } finally { spy.mockRestore(); }
}
async function update(prior: PreparedDocument, text: string, facts: Record<string, unknown>[], removes: (doc: PreparedDocument) => string[] = () => []) {
  const spy = mockNormalization(() => ({ facts, removes }), prior);
  try { return await prepareDocument("profile", text, {}, randomUUID(), { sourceText: prior.sourceText, facts: prior.facts }); } finally { spy.mockRestore(); }
}
/** id пункта CURRENT_PROFILE по фразе — так его назвала бы модель. */
const itemId = (phrase: string) => (doc: PreparedDocument) =>
  [...profileItemsOf(doc.facts).byId].filter(([, f]) => f.phrase === phrase).map(([id]) => id);
const keys = async (ids: string[]) => ids.length ? (await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids))).map((r) => r.k) : [];
const live = (doc: PreparedDocument) => doc.facts.filter((f) => (f.kind as string) !== "superseded");
const view = (doc: PreparedDocument) => ({
  skills: live(doc).filter((f) => f.kind === "capability").map((f) => f.phrase).sort(),
  resources: live(doc).filter((f) => f.kind === "resource" && f.resourceRole === "available").map((f) => f.phrase).sort(),
  // Как раздел «Ограничения»: действующие отказы (кроме отозванных навыков) и рамки времени.
  restrictions: live(doc).filter((f) => (f.kind === "exclude" && !isRevokedCapability(f)) || f.kind === "availability")
    .map((f) => (f.kind === "exclude" ? `Не выполняю: ${f.phrase}` : f.phrase)),
});

const START = "Ремонтирую бытовую технику. Есть машина, самолет, кофемашина и генератор. Могу копать.";
const startFacts = [
  { phrase: "ремонт бытовой техники", evidence: START, canonicalKeys: ["appliance_repair"] },
  { phrase: "копать", evidence: START, canonicalKeys: ["digging"] },
  ...["машина", "самолет", "кофемашина", "генератор"].map((p) => ({ kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: p, evidence: START, canonicalKeys: p === "машина" ? ["car"] : [] })),
];
async function base() {
  const p1 = await first(START, startFacts);
  return update(p1, "Работаю до 21:00", [{ kind: "availability", phrase: "работаю до 21:00", evidence: "Работаю до 21:00", constraintType: "availability", endHour: 21 }]);
}

describe("profile update by one message", () => {
  it("the model sees only the new message and the current profile; the source text stays cumulative", async () => {
    seen.length = 0;
    const p = await base();
    expect(seen.at(-1)!.text).toBe("Работаю до 21:00");
    expect(seen.at(-1)!.items).toEqual(expect.arrayContaining([{ id: expect.any(String), type: "skill", phrase: "копать" }, { id: expect.any(String), type: "resource", phrase: "генератор" }]));
    expect(p.sourceText).toBe([START, "Работаю до 21:00"].join(SEP));
    expect(view(p)).toEqual({ skills: ["копать", "ремонт бытовой техники"], resources: ["кофемашина", "генератор", "машина", "самолет"].sort(), restrictions: ["работаю до 21:00"] });
  });

  it("earlier items stay exactly as they were when the model does not repeat them", async () => {
    const p = await update(await base(), "Есть ещё перфоратор", [{ kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "перфоратор", evidence: "Есть ещё перфоратор", canonicalKeys: ["drill"] }]);
    expect(view(p)).toEqual({ skills: ["копать", "ремонт бытовой техники"], resources: ["кофемашина", "генератор", "машина", "перфоратор", "самолет"].sort(), restrictions: ["работаю до 21:00"] });
  });

  it("«Генератор я продал» → «Убери кофемашину из ресурсов»: only those resources go, nothing else changes", async () => {
    let p = await update(await base(), "Генератор я продал", [{ kind: "resource", subjectType: "physical_resource", resourceRole: "missing", phrase: "генератор", evidence: "Генератор я продал" }], itemId("генератор"));
    p = await update(p, "Убери кофемашину из ресурсов", [], itemId("кофемашина"));
    expect(view(p)).toEqual({ skills: ["копать", "ремонт бытовой техники"], resources: ["машина", "самолет"], restrictions: ["работаю до 21:00"] });
  });

  it("revoke and take again: «Не хочу больше копать» → «Могу копать»", async () => {
    const msg = "Не хочу больше копать";
    let p = await update(await base(), msg, [{ kind: "exclude", phrase: "копать", evidence: msg, constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "revoke" }], itemId("копать"));
    expect(view(p)).toEqual({ skills: ["ремонт бытовой техники"], resources: ["кофемашина", "генератор", "машина", "самолет"].sort(), restrictions: ["работаю до 21:00"] });
    expect(live(p).filter(isRevokedCapability)).toHaveLength(1);
    const dig = (doc: PreparedDocument) => doc.facts.filter((f) => f.kind === "capability" || f.kind === "exclude");
    expect(evaluateSemantic({ capabilities: dig(p), requirements: dig(p).filter((f) => f.kind === "exclude").map((f) => ({ ...f, kind: "capability" as const })), relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false }).reason).toBe("explicit_exclusion");
    // A repeated refusal of the already removed skill is the same revoke, not a new visible restriction.
    p = await update(p, "Больше не копаю", [{ kind: "exclude", phrase: "копать", evidence: "Больше не копаю", constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "restriction" }]);
    expect(view(p).restrictions).toEqual(["работаю до 21:00"]);
    p = await update(p, "Могу копать", [{ phrase: "копать", evidence: "Могу копать", canonicalKeys: ["digging"] }], itemId("копать"));
    expect(view(p).skills).toEqual(["копать", "ремонт бытовой техники"]);
    expect(live(p).filter((f) => f.kind === "exclude")).toEqual([]);
  });

  it("server backstop: a revoke the model did not list in removes still removes the earlier skill", async () => {
    const msg = "Больше не ремонтирую бытовую технику";
    const p = await update(await base(), msg, [{ kind: "exclude", phrase: "ремонт бытовой техники", evidence: msg, constraintType: "exclusion", canonicalKeys: ["appliance_repair"], refusalIntent: "revoke" }]);
    expect(view(p).skills).toEqual(["копать"]);
    expect(view(p).restrictions).toEqual(["работаю до 21:00"]);
  });

  it("«Теперь работаю до 18:00» replaces the earlier time limit; the old one stays history", async () => {
    const msg = "Теперь работаю до 18:00";
    const p = await update(await base(), msg, [{ kind: "availability", phrase: "работаю до 18:00", evidence: msg, constraintType: "availability", endHour: 18 }], itemId("работаю до 21:00"));
    expect(view(p).restrictions).toEqual(["работаю до 18:00"]);
    expect(p.facts.filter((f) => (f.kind as string) === "superseded").map((f) => f.phrase)).toContain("работаю до 21:00");
  });

  it("«Холодильники больше не ремонтирую» (restriction): the broader repair skill stays", async () => {
    const msg = "Холодильники больше не ремонтирую";
    const p = await update(await base(), msg, [{ kind: "exclude", phrase: "ремонт холодильников", evidence: msg, constraintType: "exclusion", canonicalKeys: ["refrigerator_repair"], refusalIntent: "restriction" }]);
    expect(view(p).skills).toEqual(["копать", "ремонт бытовой техники"]);
    expect(view(p).restrictions).toEqual(expect.arrayContaining(["Не выполняю: ремонт холодильников", "работаю до 21:00"]));
  });

  it("the user's history replayed message by message gives the expected profile", async () => {
    const answers: Record<string, { facts: Record<string, unknown>[]; removes?: (d: PreparedDocument) => string[] }> = {
      [START]: { facts: startFacts },
      "Работаю до 21:00": { facts: [{ kind: "availability", phrase: "работаю до 21:00", evidence: "Работаю до 21:00", constraintType: "availability", endHour: 21 }] },
      "Не хочу больше копать": { facts: [{ kind: "exclude", phrase: "копать", evidence: "Не хочу больше копать", constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "revoke" }], removes: itemId("копать") },
      "Генератор я продал": { facts: [], removes: itemId("генератор") },
      "Убери кофемашину из ресурсов": { facts: [], removes: itemId("кофемашина") },
      "Могу копать": { facts: [{ phrase: "копать", evidence: "Могу копать", canonicalKeys: ["digging"] }], removes: itemId("копать") },
    };
    let current: PreparedDocument | undefined;
    const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
      const a = answers[input.text]!;
      return { data: { facts: a.facts.map(fact), ...(input.profileItems && a.removes && current ? { removes: a.removes(current) } : {}) },
        provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } as never;
    });
    try {
      // prepareProfileFromMessages calls prepareDocument for each message in turn; track the state between calls.
      const texts = Object.keys(answers);
      current = await prepareDocument("profile", texts[0]!, {}, randomUUID());
      for (const t of texts.slice(1)) current = await prepareDocument("profile", t, {}, randomUUID(), { sourceText: current.sourceText, facts: current.facts });
      const replayed = view(current);
      expect(replayed).toEqual({ skills: ["копать", "ремонт бытовой техники"], resources: ["машина", "самолет"], restrictions: ["работаю до 21:00"] });
      expect(await keys(live(current).filter((f) => f.phrase === "копать" && f.kind === "capability").flatMap((f) => f.nodeIds))).toEqual(["digging"]);
      // The rebuild helper replays the same way (removes cannot be predicted there, so the backstop must hold).
      current = undefined;
      const rebuilt = await prepareProfileFromMessages(texts, {}, randomUUID());
      expect(view(rebuilt).skills).toEqual(["копать", "ремонт бытовой техники"]);
      expect(view(rebuilt).restrictions).toEqual(["работаю до 21:00"]);
    } finally { spy.mockRestore(); }
  });
});
