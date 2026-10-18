import { expect, it, vi } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { semanticFactSchema } from "@ustal/validation";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ OPENAI_API_KEY: "test", AI_MODEL_NORMALIZATION: "norm-test" }) }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; }, toFile: vi.fn() }));
import { openAiExtraction } from "./openai.js";

// Profile update by one message (2026-10-13): the first message of a profile and every order must send the model
// exactly the previous wire schema; only the update mode adds CURRENT_PROFILE and `removes`.
const meta = { operationType: "matching_normalization", traceId: "t", promptVersion: "t", schemaVersion: "v2" };
const reply = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] });
const fact = { kind: "capability", subjectType: "unspecified", constraintType: "none", constraintScope: "whole_task", resourceRole: "none",
  resourceCapacity: { value: null, unit: null, kind: null }, phrase: "копать", evidence: "source_0", canonicalKeys: [], confidence: 0.9,
  mandatory: false, startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null };
const call = () => create.mock.lastCall![0];
const DAYS_MODE_DESCRIPTION = "excluded = listed days are NOT worked (не работаю/не беру по ...); allowed = work is limited to ONLY the listed days (только/only/с пн по пт); null = no day limit, including 'могу работать по воскресеньям' / 'can work Sundays'";

/** The wire schema as it was before `removes` existed (same post-processing as the provider). */
function previousSchema(kind: "profile" | "order", spanIds: string[]) {
  const base = z.object({ facts: z.array(semanticFactSchema).max(40) });
  const schema = kind === "order" ? base.extend({ physicalConstraints: semanticFactSchema.array().max(40) }) : base;
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as any;
  for (const key of kind === "order" ? ["facts", "physicalConstraints"] : ["facts"]) {
    const items = json.properties[key].items;
    // label/attributes/itemRef (2026-10-15) did not exist in the previous wire schema.
    for (const k of ["label", "attributes", "itemRef"]) delete items.properties[k];
    if (kind === "order") delete items.properties.refusalIntent;
    // Days of week (2026-10-17): the wire carries an explicit sign daysMode right before daysOfWeek (both kinds);
    // the server converts it to allowed days (resolveDaysOfWeek) — the public SemanticFact shape is unchanged.
    items.properties = Object.fromEntries(Object.entries(items.properties).flatMap(([k, v]) => k === "daysOfWeek"
      ? [["daysMode", { anyOf: [{ type: "string", enum: ["allowed", "excluded"] }, { type: "null" }], description: DAYS_MODE_DESCRIPTION }], [k, v]] : [[k, v]]));
    items.required = Object.keys(items.properties);
    items.properties.evidence = { type: "string", enum: spanIds };
  }
  return json;
}

/** Profile items (2026-10-15): the profile wire schema adds label (right after phrase) and attributes; orders do not. */
function profileItemSchema(spanIds: string[]) {
  const json = previousSchema("profile", spanIds);
  const items = json.properties.facts.items;
  items.properties = Object.fromEntries(Object.entries(items.properties).flatMap(([k, v]) => k === "phrase" ? [[k, v], ["label", { type: ["string", "null"] }]] : [[k, v]]));
  items.properties.attributes = { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "value", "unit"],
    properties: { key: { type: "string" }, value: { anyOf: [{ type: "number" }, { type: "string" }] }, unit: { type: ["string", "null"] } } } };
  items.required = Object.keys(items.properties);
  return json;
}

it("an order keeps exactly the previous schema; the first profile message adds only label/attributes", async () => {
  for (const kind of ["order", "profile"] as const) {
    create.mockResolvedValue(reply(kind === "order" ? { facts: [fact], physicalConstraints: [] } : { facts: [{ ...fact, label: "Копка", attributes: [] }] }));
    const r = await openAiExtraction.normalizeMatching({ kind, text: "Могу копать", extracted: {}, ontology: [] }, meta);
    expect(call().response_format.json_schema.schema).toEqual(kind === "order" ? previousSchema(kind, ["source_0"]) : profileItemSchema(["source_0"]));
    expect(call().messages[0].content.includes("PROFILE ITEMS")).toBe(kind === "profile");
    const user = JSON.parse(call().messages[1].content);
    expect(Object.keys(user)).toEqual(["SOURCE", "EVIDENCE_SPANS", "kind", "ONTOLOGY"]);
    expect(call().messages[0].content).not.toContain("PROFILE UPDATE");
    expect(r.data.removes).toBeUndefined();
  }
});

it("a profile update sends CURRENT_PROFILE and accepts only known item ids in removes", async () => {
  const profileItems = [{ id: "item_1", type: "skill" as const, phrase: "копать" }, { id: "item_2", type: "resource" as const, phrase: "генератор" }];
  create.mockResolvedValue(reply({ facts: [], removes: ["item_2", "item_9"] }));
  const r = await openAiExtraction.normalizeMatching({ kind: "profile", text: "Генератор я продал", extracted: {}, ontology: [], profileItems }, meta);
  const schema = call().response_format.json_schema.schema;
  expect(schema.required).toContain("removes");
  expect(schema.properties.removes).toEqual({ type: "array", items: { type: "string", enum: ["item_1", "item_2"] } });
  // itemRef (2026-10-15): only known item ids or null; the server verifies the link (profile-update-guard).
  expect(schema.properties.facts.items.properties.itemRef).toEqual({ anyOf: [{ type: "string", enum: ["item_1", "item_2"] }, { type: "null" }] });
  expect(schema.properties.facts.items.required).toContain("itemRef");
  expect(JSON.parse(call().messages[1].content).CURRENT_PROFILE).toEqual(profileItems);
  expect(call().messages[0].content).toContain("PROFILE UPDATE (this call)");
  expect(r.data.removes).toEqual(["item_2"]);
});
