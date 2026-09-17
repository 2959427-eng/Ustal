import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  assertLocalTestDatabase,
  getDb,
  getSql,
  schema,
} from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import type { SemanticFact } from "@ustal/validation";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { dispatchRematches } from "./rematch.js";
import { reprocessOrder, reprocessProfile } from "./reprocess.js";
import { requestRematch, prepareDocument } from "./semantic.js";

assertLocalTestDatabase();
const db = getDb();
const ids: string[] = [],
  cities: string[] = [],
  orders: string[] = [];
const fixtures = new Map<
  string,
  { facts: SemanticFact[]; actions: string[] }
>();
const vectors = new Map<string, number[]>();
const vector = (axis: number) =>
  Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0));
const wrap = <T>(data: T) => ({
  data,
  provider: "mock",
  model: "fixture-v2",
  latencyMs: 0,
  tokensInput: 0,
  tokensOutput: 0,
});
function fact(
  phrase: string,
  keys: string[],
  axis: number,
  kind: SemanticFact["kind"] = "capability",
  mandatory = false,
): SemanticFact {
  vectors.set(phrase, vector(axis));
  return {
    phrase,
    canonicalKeys: keys,
    kind,
    mandatory,
    confidence: 0.95,
    evidence: "fixture",
    constraintType: "none",
    constraintScope: "fact",
    resourceRole: "none",
    resourceCapacity: { value: null, unit: null, kind: null },
    startHour: null,
    endHour: null,
    daysOfWeek: null,
  };
}
function fixture(text: string, facts: SemanticFact[], actions: string[] = []) {
  fixtures.set(text, { facts, actions });
  return text;
}
let city: string, otherCity: string;
async function user(cityId = city) {
  const [u] = await db
    .insert(schema.users)
    .values({
      phone: randomUUID().slice(0, 20),
      passwordHash: "local-test",
      status: "active",
    })
    .returning();
  ids.push(u!.id);
  await db
    .insert(schema.userProfiles)
    .values({
      userId: u!.id,
      name: "TEST semantic",
      cityId,
      acceptedPdnAt: new Date(),
      acceptedRulesAt: new Date(),
    });
  return u!.id;
}
async function profile(userId: string, text: string, apply = true) {
  const [source] = await db
    .insert(schema.profileSourceInputs)
    .values({ userId, inputType: "text", rawText: text, status: "confirmed" })
    .returning();
  const p = await handleProfileExtraction({
    id: randomUUID(),
    data: { userId, sourceInputId: source!.id },
  } as never);
  if (apply)
    await db.transaction(async (tx) => {
      await tx
        .update(schema.capabilityProfiles)
        .set({ status: "superseded" })
        .where(eq(schema.capabilityProfiles.userId, userId));
      await tx
        .update(schema.capabilityProfiles)
        .set({ status: "applied" })
        .where(eq(schema.capabilityProfiles.id, p.profileId));
      await requestRematch(tx, userId);
    });
  return p;
}
async function order(authorId: string, text: string) {
  const [o] = await db
    .insert(schema.orders)
    .values({ authorId, cityId: city, sourceText: text, status: "processing" })
    .returning();
  orders.push(o!.id);
  await handleOrderExtraction({
    id: randomUUID(),
    data: { orderId: o!.id },
  } as never);
  await db
    .update(schema.orders)
    .set({ status: "published" })
    .where(eq(schema.orders.id, o!.id));
  return o!.id;
}
async function matches(orderId: string, userId: string) {
  const run = await handleMatchingRun({
    id: randomUUID(),
    data: { orderId },
  } as never);
  if (!("matchingRunId" in run)) throw Error("matching skipped");
  return db.query.matchingCandidates.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.matchingRunId, run.matchingRunId), eq(t.userId, userId)),
  });
}
beforeAll(async () => {
  for (const name of ["TEST semantic A", "TEST semantic B"]) {
    const [c] = await db
      .insert(schema.cities)
      .values({
        name,
        regionName: "TEST",
        federalDistrict: "TEST",
        timezone: "Asia/Vladivostok",
        isActive: false,
      })
      .returning();
    cities.push(c!.id);
  }
  [city, otherCity] = cities as [string, string];
  vi.spyOn(
    mockProviders.extraction,
    "extractCapabilityProfile",
  ).mockImplementation(async (input) =>
    wrap({ summary: input.text, capabilities: [], resources: [] }),
  );
  vi.spyOn(mockProviders.extraction, "extractOrder").mockImplementation(
    async (input) =>
      wrap({
        normalizedTitle: input.text,
        normalizedDescription: input.text,
        actions: fixtures.get(input.text)?.actions ?? [],
        requiredCapabilities: [],
        desiredCapabilities: [],
        requiredResources: [],
        desiredResources: [],
        physicalRequirements: [],
        complexity: "low",
        requiresQualification: false,
        regulated: false,
        estimatedDurationMinutes: null,
        contextualChips: [],
      }),
  );
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(
    async (input) => {
      const data = [...fixtures]
        .reverse()
        .find(([text]) => input.text.includes(text))?.[1];
      if (!data) throw Error("Missing explicit provider fixture");
      return wrap({
        facts: data.facts.map((f) => ({ ...f, evidence: input.text })),
      });
    },
  );
  vi.spyOn(mockProviders.embedding, "embed").mockImplementation(async (texts) =>
    wrap({
      vectors: texts.map(
        (text) =>
          vectors.get(text) ?? vectors.get(text.split("\n")[0]!) ?? vector(100),
      ),
    }),
  );
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  if (orders.length)
    await db
      .delete(schema.moderationCases)
      .where(inArray(schema.moderationCases.orderId, orders));
  if (orders.length)
    await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  if (ids.length)
    await db.delete(schema.users).where(inArray(schema.users.id, ids));
  if (cities.length)
    await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});

describe("semantic pipeline on real isolated PostgreSQL; fixture AI, no external models", () => {
  it("keeps an over-budget review run atomic at city scale", async () => {
    const previousCity = city;
    const [isolated] = await db.insert(schema.cities).values({name: `TEST review budget ${randomUUID()}`,regionName:"TEST",federalDistrict:"TEST",timezone:"Asia/Vladivostok",isActive:false}).returning();
    city = isolated!.id; cities.push(city);
    const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue(wrap({compatible:false,confidence:.95,reason:"Different actions"}));
    try {
      const a = await user();
      fixture("Budget profile", [fact("ordinary action one", [], 32)]);
      fixture("Budget order", [fact("ordinary action two", [], 33)]);
      for (let i = 0; i < 21; i++) await profile(await user(), "Budget profile");
      const oid = await order(a, "Budget order");
      await expect(handleMatchingRun({id:randomUUID(),data:{orderId:oid}} as never)).rejects.toThrow("Semantic review budget exceeded");
      expect(review).toHaveBeenCalledTimes(20);
      expect((await db.select().from(schema.matchingRuns).where(eq(schema.matchingRuns.orderId, oid))).length).toBe(0);
    } finally { review.mockRestore(); city = previousCity; }
  }, 30000);
  it("reviews low-cosine unmapped actions using immutable full source context", async () => {
    const previousCity = city;
    const [isolated] = await db.insert(schema.cities).values({name: `TEST source review ${randomUUID()}`,regionName:"TEST",federalDistrict:"TEST",timezone:"Asia/Vladivostok",isActive:false}).returning();
    city = isolated!.id; cities.push(city);
    const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue(wrap({compatible:true,confidence:.95,reason:"Related ordinary activity"}));
    try {
      const a = await user(), u = await user();
      const source = "Помогаю упорядочивать вещи, только в дневное время";
      const requested = "Днём нужна помощь с сортировкой вещей";
      fixture(source, [fact("упорядочить вещи", [], 30)]);
      fixture(requested, [fact("рассортировать вещи", [], 31)]);
      await profile(u, source);
      const oid = await order(a, requested);
      expect(await matches(oid, u)).toBeDefined();
      expect(review).toHaveBeenCalledWith({profile:[source],order:[requested]}, expect.anything());
      expect(review).toHaveBeenCalledTimes(1);
      await db.transaction(tx => requestRematch(tx, u));
      review.mockRejectedValueOnce(new Error("review timeout"));
      await expect(matches(oid, u)).rejects.toThrow("review timeout");
      // The failed review must not replace the completed run or publish partial candidates.
      expect((await db.select().from(schema.matchingRuns).where(eq(schema.matchingRuns.orderId, oid))).length).toBe(1);
      expect(await matches(oid, u)).toBeDefined();
      expect((await db.select().from(schema.matchingRuns).where(eq(schema.matchingRuns.orderId, oid))).length).toBe(2);
    } finally { review.mockRestore(); city = previousCity; }
  });
  it("deduplicates projected nodes and concurrent rematches; invalidates on profile watermark", async () => {
    const a=await user(),u=await user();
    fixture("Duplicate skills",[fact("Погрузка один",["loading"],12),fact("Погрузка два",["loading"],12)]);
    fixture("Duplicate order",[fact("Погрузить",["loading"],12)]);
    const p=await profile(u,"Duplicate skills"),oid=await order(a,"Duplicate order");
    expect((await db.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId,p.profileId))).length).toBe(1);
    const run=()=>handleMatchingRun({id:randomUUID(),data:{orderId:oid}} as never);
    const [one,two]=await Promise.all([run(),run()]);
    expect(one).toEqual(two);
    expect((await db.select().from(schema.matchingRuns).where(eq(schema.matchingRuns.orderId,oid))).length).toBe(1);
    await db.transaction(tx=>requestRematch(tx,u));
    expect(await run()).not.toEqual(one);
  });
  it("order retry after AI failure recovers once without duplicate projections or lost requirements", async () => {
    const a=await user();fixture("Retry loading",[fact("Погрузка retry",["loading"],13)]);
    const [o]=await db.insert(schema.orders).values({authorId:a,cityId:city,sourceText:"Retry loading",status:"processing"}).returning();orders.push(o!.id);
    const run=()=>handleOrderExtraction({id:randomUUID(),data:{orderId:o!.id}} as never);
    vi.spyOn(mockProviders.embedding,"embed").mockRejectedValueOnce(new Error("injected timeout"));
    await expect(run()).rejects.toThrow("injected timeout");
    expect((await db.query.orders.findFirst({where:eq(schema.orders.id,o!.id)}))?.status).toBe("processing_failed");
    expect((await db.select().from(schema.matchingDocuments).where(eq(schema.matchingDocuments.orderId,o!.id))).length).toBe(0);
    await run();await run();
    expect((await db.query.orders.findFirst({where:eq(schema.orders.id,o!.id)}))?.status).toBe("processing");
    expect((await db.select().from(schema.orderAiExtractions).where(eq(schema.orderAiExtractions.orderId,o!.id))).length).toBe(1);
    expect((await db.select().from(schema.orderRequirements).where(eq(schema.orderRequirements.orderId,o!.id))).length).toBe(1);
  });
  it.each([
    [
      "Могу работать грузчиком",
      "Нужно помочь с погрузкой и разгрузкой вещей",
      ["loading"],
      ["loading", "unloading"],
      1,
    ],
    [
      "Могу таскать мебель и помогать при переездах",
      "Нужно вынести шкаф и загрузить в машину",
      ["loading", "moving_help"],
      ["manual_carrying", "loading"],
      2,
    ],
    [
      "Есть машина, могу отвозить вещи",
      "Нужно отвезти коробки",
      ["delivery"],
      ["delivery"],
      3,
    ],
    [
      "Могу подключить стиральную машину",
      "Нужно установить и подключить стиралку",
      ["washing_machine_install"],
      ["washing_machine_install"],
      4,
    ],
  ] as const)("matches %s → %s", async (pText, oText, pKeys, oKeys, axis) => {
    const author = await user(),
      executor = await user();
    fixture(pText, [
      fact(pText, [...pKeys], axis),
      ...(axis === 3
        ? [fact("легковой автомобиль", ["car"], 30, "resource")]
        : []),
    ]);
    fixture(oText, [
      fact(oText, [...oKeys], axis),
      ...(axis === 3
        ? [fact("нужен транспорт", ["vehicle_use"], 30, "resource", true)]
        : []),
    ]);
    await profile(executor, pText);
    const oid = await order(author, oText);
    expect(await matches(oid, executor)).toBeDefined();
    expect(await matches(oid, author)).toBeUndefined();
  });
  it("rejects explicit electrical refusal even with identical positive vectors", async () => {
    const a = await user(),
      u = await user();
    fixture("Электрику не делаю", [
      fact("электромонтаж", ["electrical_work"], 5, "exclude"),
    ]);
    fixture("Нужно заменить розетку", [
      fact("замена розетки", ["electrical_work"], 5),
    ]);
    await profile(u, "Электрику не делаю");
    const oid = await order(a, "Нужно заменить розетку");
    expect(await matches(oid, u)).toBeUndefined();
  });
  it("rejects a different city and never uses a newer draft", async () => {
    const a = await user(),
      u = await user(otherCity);
    fixture("Другой город: погрузка", [fact("погрузка", ["loading"], 6)]);
    fixture("Заказ: погрузка", [fact("погрузка", ["loading"], 6)]);
    await profile(u, "Другой город: погрузка");
    const oid = await order(a, "Заказ: погрузка");
    expect(await matches(oid, u)).toBeUndefined();
    const draftUser = await user();
    await profile(draftUser, "Другой город: погрузка", false);
    expect(await matches(oid, draftUser)).toBeUndefined();
  });
  it("semantic-only survives zero canonical nodes", async () => {
    const a = await user(),
      u = await user();
    fixture("Могу переносить тяжёлые вещи", [fact("перенос тяжестей", [], 7)]);
    fixture("Нужно разгрузить шкафы", [fact("перемещение шкафов", [], 7)]);
    await profile(u, "Могу переносить тяжёлые вещи");
    const oid = await order(a, "Нужно разгрузить шкафы");
    const result = await matches(oid, u);
    expect(result?.matchType).toBe("probable");
    expect((result?.breakdown as { match_type: string }).match_type).toBe(
      "semantic-only",
    );
  });
  it("actions alone populate structural requirements and later profile change rematches old order", async () => {
    const a = await user(),
      u = await user();
    fixture("Без навыка", []);
    fixture("Позднее могу разгружать", [fact("разгрузка", ["unloading"], 8)]);
    fixture("Заказ с actions", [], ["разгрузка"]);
    vectors.set("разгрузка", vector(8));
    await profile(u, "Без навыка");
    const oid = await order(a, "Заказ с actions");
    expect(await matches(oid, u)).toBeUndefined();
    await profile(u, "Позднее могу разгружать");
    const queued: string[] = [];
    for (let i = 0; i < 20; i++) {
      await dispatchRematches(async (id) => {
        queued.push(id);
      });
      if (!(await db.query.rematchRequests.findFirst())) break;
    }
    expect(queued).toContain(oid);
    expect(await matches(oid, u)).toBeDefined();
    const reqs = await db
      .select()
      .from(schema.orderRequirements)
      .where(eq(schema.orderRequirements.orderId, oid));
    expect(reqs.length).toBeGreaterThan(0);
  });
  it("backfill preserves source, is idempotent, and refuses unproven legacy provenance", async () => {
    const a = await user(),
      u = await user();
    fixture("Backfill skill", [fact("доставка", ["delivery"], 9)]);
    fixture("Backfill order", [fact("доставка", ["delivery"], 9)]);
    const p = await profile(u, "Backfill skill"),
      oid = await order(a, "Backfill order");
    expect(
      (
        (await reprocessProfile(p.profileId, undefined, true)) as {
          reused: boolean;
        }
      ).reused,
    ).toBe(true);
    expect(
      ((await reprocessOrder(oid, true)) as { reused: boolean }).reused,
    ).toBe(true);
    expect(
      (await db.query.orders.findFirst({ where: eq(schema.orders.id, oid) }))
        ?.sourceText,
    ).toBe("Backfill order");
    const [legacy] = await db
      .insert(schema.capabilityProfiles)
      .values({
        userId: u,
        summary: "Legacy",
        profileVersion: 100,
        status: "applied",
        extractionVersion: "v1",
      })
      .returning();
    await expect(reprocessProfile(legacy!.id)).rejects.toThrow("provenance");
  });
  it("rejects unsupported evidence instead of silently granting a skill", async () => {
    vi.spyOn(
      mockProviders.extraction,
      "normalizeMatching",
    ).mockResolvedValueOnce(
      wrap({
        facts: [
          { ...fact("доставка", ["delivery"], 10), evidence: "not in source" },
        ],
      }),
    );
    await expect(
      prepareDocument("profile", "Иной текст", {}, randomUUID()),
    ).rejects.toThrow("unsupported source evidence");
  });
  it("repairs an empty legacy applied profile from a verified confirmed source", async () => {
    const u=await user();
    fixture("Подтвержденный старый навык",[fact("погрузка",["loading"],11)]);
    const [source]=await db.insert(schema.profileSourceInputs).values({userId:u,inputType:"text",rawText:"Подтвержденный старый навык",status:"confirmed"}).returning();
    const [legacy]=await db.insert(schema.capabilityProfiles).values({userId:u,summary:"Подтвержденный старый навык",profileVersion:1,status:"applied",extractionVersion:"v1"}).returning();
    expect(await reprocessProfile(legacy!.id,source!.id)).toMatchObject({dryRun:true});
    expect((await db.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId,legacy!.id))).length).toBe(0);
    expect(await reprocessProfile(legacy!.id,source!.id,true)).toMatchObject({reused:false});
    expect((await db.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId,legacy!.id))).length).toBe(1);
    expect(await reprocessProfile(legacy!.id,source!.id,true)).toMatchObject({reused:true});
  });
  it("reviews high-similarity risk cases without treating them as regulated", async () => {
    const a = await user(), u = await user();
    fixture("Qualification profile", [fact("generic activity", ["cleaning"], 12)]);
    fixture("Qualification order", [fact("generic activity", ["cleaning"], 12)]);
    await profile(u, "Qualification profile");
    const oid = await order(a, "Qualification order");
    expect(await matches(oid, u)).toBeDefined();
    const review = vi.spyOn(mockProviders.extraction, "reviewSemantic").mockResolvedValue(wrap({compatible:false,confidence:1,reason:"Safety not established"}));
    await db.update(schema.orders).set({ riskLevel: 1 }).where(eq(schema.orders.id, oid));
    expect(await matches(oid, u)).toBeUndefined();
    expect(review).toHaveBeenCalledWith({profile:["Qualification profile"],order:["Qualification order"]},expect.anything());
    review.mockResolvedValue(wrap({compatible:true,confidence:1,reason:"Suitable stated means"}));
    await db.transaction(tx=>requestRematch(tx,u));
    expect(await matches(oid, u)).toBeDefined();
    const latest = await db.query.matchingRuns.findFirst({
      where: eq(schema.matchingRuns.orderId, oid),
      orderBy: (t, { desc }) => desc(t.startedAt),
    });
    const trace = await db.query.matchingTraces.findFirst({
      where: (t, { and, eq }) => and(eq(t.matchingRunId, latest!.id), eq(t.userId, u)),
    });
    expect(trace?.detail).toMatchObject({ match_type: "exact", safety_review_required: true });
    review.mockRestore();
  });
  it("persists workload on a capability as a compatibility gate before exact matching", async () => {
    const a=await user(),u=await user();
    fixture("Capacity profile",[fact("доставка",["delivery"],14)]);
    fixture("Capacity order",[{...fact("доставка",["delivery"],14),resourceCapacity:{value:900,unit:"литр",kind:null}}]);
    await profile(u,"Capacity profile");
    const oid=await order(a,"Capacity order");
    const review=vi.spyOn(mockProviders.extraction,"reviewSemantic").mockResolvedValue(wrap({compatible:false,confidence:1,reason:"Suitable capacity not established"}));
    try {
      expect(await matches(oid,u)).toBeUndefined();
      expect(review).toHaveBeenCalledWith({profile:["Capacity profile"],order:["Capacity order"]},expect.anything());
      const doc=await db.query.matchingDocuments.findFirst({where:eq(schema.matchingDocuments.orderId,oid)});
      const facts=await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId,doc!.id));
      expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({kind:"resource",resourceRole:"compatibility",mandatory:false,resourceCapacity:{value:900,unit:"литр",kind:null}})]));
    } finally { review.mockRestore(); }
  });
});
