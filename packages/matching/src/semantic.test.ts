import { describe, it, expect } from "vitest";
import { evaluateSemantic, cosine, type Fact } from "./semantic.js";
const f = (kind: string, id: string, mandatory = false): Fact => ({
  kind,
  nodeIds: id ? [id] : [],
  phrase: id,
  mandatory,
  confidence: 1,
  embedding: [1, 0],
});
const run = (
  capabilities: Fact[],
  requirements: Fact[],
  extra: Partial<Parameters<typeof evaluateSemantic>[0]> = {},
) =>
  evaluateSemantic({
    capabilities,
    requirements,
    relations: [],
    documentSimilarity: 1,
    riskLevel: 0,
    regulated: false,
    ...extra,
  });
describe("evidence gates preserve safety while allowing relevant adjacent work", () => {
  it("does not treat ordinary riskLevel as an automatic qualification reject", () => {
    const caps = [f("capability", "shared-category")];
    const reqs = [f("capability", "shared-category")];
    expect(run(caps, reqs).classification).toBe("exact");
    for (const riskLevel of [1, 2]) {
      expect(run(caps, reqs, {
        riskLevel,
        semanticReview: { compatible: true, confidence: 1, reason: "Related activity" },
      }).classification).toBe("exact");
    }
  });
  it.each([0, 0.23, 0.487])("allows verified relevance at cosine %s without weakening gates", (similarity) => {
    const c={...f("capability",""),embedding:[similarity,Math.sqrt(1-similarity**2)]};
    const req=f("capability","");
    const options={documentSimilarity:similarity,semanticReview:{compatible:true,confidence:0.95,reason:"Related manual work"}};
    expect(run([c],[req],{documentSimilarity:similarity}).classification).toBe("reject");
    expect(run([c],[req],options).classification).toBe("semantic-only");
    expect(run([c],[req],{...options,riskLevel:1}).classification).toBe("semantic-only");
    expect(run([c],[{...req,mandatory:true}],options).classification).toBe("semantic-only");
    expect(run([c],[req,f("resource","van",true)],options).reason).toBe("missing_mandatory_resource");
    expect(run([c,f("exclude","")],[req],options).reason).toBe("explicit_exclusion");
    expect(run([c],[req],{...options,semanticReview:{compatible:false,confidence:1,reason:"Unrelated"}}).classification).toBe("reject");
  });
  it("does not turn an owned car into a skill", () =>
    expect(
      run([f("resource", "car")], [f("capability", "delivery")]).classification,
    ).toBe("reject"));
  it("never waives a mandatory resource using vectors", () =>
    expect(
      run(
        [f("capability", "delivery")],
        [f("capability", "delivery"), f("resource", "van", true)],
      ).reason,
    ).toBe("missing_mandatory_resource"));
  it("allows a concrete asset to satisfy its generic parent", () =>
    expect(
      run(
        [f("capability", "delivery"), f("resource", "car")],
        [f("capability", "delivery"), f("resource", "vehicle", true)],
        {
          relations: [
            { fromNodeId: "car", toNodeId: "vehicle", relationType: "is_a" },
          ],
        },
      ).classification,
    ).toBe("exact"));
  it("does not infer a van from a generic vehicle", () =>
    expect(
      run(
        [f("capability", "delivery"), f("resource", "vehicle")],
        [f("capability", "delivery"), f("resource", "van", true)],
        {
          relations: [
            { fromNodeId: "van", toNodeId: "vehicle", relationType: "is_a" },
          ],
        },
      ).classification,
    ).toBe("reject"));
  it("rejects an unmapped exclusion semantically", () =>
    expect(
      run([f("capability", ""), f("exclude", "")], [f("capability", "")])
        .reason,
    ).toBe("explicit_exclusion"));
  it("rejects a conflicting daily window", () =>
    expect(
      run(
        [
          f("capability", "loading"),
          { ...f("availability", ""), startHour: 18, endHour: 23 },
        ],
        [f("capability", "loading")],
        { localHour: 10 },
      ).reason,
    ).toBe("outside_availability"));
  it("marks an unknown schedule for confirmation", () =>
    expect(
      run(
        [
          f("capability", "loading"),
          { ...f("availability", ""), startHour: 18, endHour: 23 },
        ],
        [f("capability", "loading")],
      ).trace.availability,
    ).toBe("needs_confirmation"));
  it("supports overnight availability", () =>
    expect(
      run(
        [
          f("capability", "loading"),
          { ...f("availability", ""), startHour: 22, endHour: 6 },
        ],
        [f("capability", "loading")],
        { localHour: 1 },
      ).classification,
    ).toBe("exact"));
  it("keeps regulated work closed even for exact skills", () =>
    expect(
      run([f("capability", "electric")], [f("capability", "electric")], {
        regulated: true,
      }).reason,
    ).toBe("regulated_unverified"));
  it("allows a broad related edge for an ordinary non-regulated capability", () =>
    expect(
      run(
        [{ ...f("capability", "general"), embedding: [0, 1] }],
        [f("capability", "qualified", true)],
        {
          riskLevel: 1,
          relations: [
            {
              fromNodeId: "general",
              toNodeId: "qualified",
              relationType: "related",
            },
          ],
        },
      ).classification,
      ).toBe("strong"));
    it("allows general capability coverage for a specific mandatory action", () =>
      expect(
        run(
          [f("capability", "general-cleaning")],
          [f("capability", "post-renovation-cleaning", true)],
          {
            relations: [
              {
                fromNodeId: "post-renovation-cleaning",
                toNodeId: "general-cleaning",
                relationType: "is_a",
              },
            ],
          },
        ).classification,
      ).toBe("strong"));
    it("allows partial mandatory capability coverage when the topic is related", () =>
      expect(
        run(
          [f("capability", "loading")],
          [f("capability", "loading", true), f("capability", "manual-carrying", true)],
        ).classification,
      ).toBe("strong"));
    it("keeps unrelated topics rejected despite a shared low-information context", () =>
      expect(
        run(
          [{ ...f("capability", "cleaning"), embedding: [1, 0] }],
          [{ ...f("capability", "car-repair", true), embedding: [0, 1] }],
          { documentSimilarity: 0 },
        ).reason,
      ).toBe("insufficient_capability_evidence"));
    it("keeps regulated electrical work rejected without verification", () =>
      expect(
        run([f("capability", "electrical")], [f("capability", "electrical")], {
          regulated: true,
        }).reason,
      ).toBe("regulated_unverified"));
    it("matches moving work when lifting/loading covers adjacent carrying tasks", () =>
      expect(
        run(
          [f("capability", "loading"), f("capability", "heavy-lifting")],
          [f("capability", "manual-carrying", true), f("capability", "unloading", true)],
          {
            relations: [
              { fromNodeId: "manual-carrying", toNodeId: "heavy-lifting", relationType: "is_a" },
              { fromNodeId: "unloading", toNodeId: "loading", relationType: "related" },
            ],
          },
        ).matchType,
      ).not.toBeNull());
    it("matches general cleaning for a post-renovation cleaning specialization", () =>
      expect(
        run(
          [f("capability", "general-cleaning")],
          [f("capability", "post-renovation-cleaning", true)],
          {
            relations: [
              { fromNodeId: "post-renovation-cleaning", toNodeId: "general-cleaning", relationType: "is_a" },
            ],
          },
        ).matchType,
      ).not.toBeNull());
    it("matches ordinary faucet replacement without a qualification gate", () =>
      expect(
        run(
          [f("capability", "plumbing-repair")],
          [f("capability", "faucet-replacement", true)],
          {
            riskLevel: 1,
            relations: [
              { fromNodeId: "faucet-replacement", toNodeId: "plumbing-repair", relationType: "is_a" },
            ],
          },
        ).matchType,
      ).not.toBeNull());
    it("rejects cleaning against car repair", () =>
      expect(
        run(
          [{ ...f("capability", "cleaning"), embedding: [1, 0] }],
          [{ ...f("capability", "car-repair", true), embedding: [0, 1] }],
          { documentSimilarity: 0 },
        ).matchType,
      ).toBeNull());
    it("rejects driving against plumbing", () =>
      expect(
        run(
          [{ ...f("capability", "driving"), embedding: [1, 0] }],
          [{ ...f("capability", "plumbing"), embedding: [0, 1] }],
          { documentSimilarity: 0 },
        ).matchType,
      ).toBeNull());
    it("keeps explicit negative constraints as hard rejects", () =>
      expect(
        run(
          [f("capability", "cleaning"), f("exclude", "car-repair")],
          [f("capability", "car-repair")],
        ).reason,
      ).toBe("explicit_exclusion"));
  it("requires source review for weak partial canonical overlap", () =>
    expect(
      run(
        [f("capability", "broad")],
        [f("capability", "specific", true), f("capability", "other", true)],
        {
          documentSimilarity: 0.2,
          relations: [
            { fromNodeId: "broad", toNodeId: "specific", relationType: "is_a" },
          ],
        },
      ).reason,
    ).toBe("insufficient_capability_evidence"));
  it("keeps verified adjacent ordinary work matchable", () =>
    expect(
      run(
        [f("capability", "general")],
        [f("capability", "specific", true)],
        {
          documentSimilarity: 0.2,
          relations: [
            { fromNodeId: "general", toNodeId: "specific", relationType: "related" },
          ],
          semanticReview: { compatible: true, confidence: 0.95, reason: "same ordinary task family" },
        },
      ).matchType,
    ).not.toBeNull());
  it("lets a negative review veto a low-similarity risk-sensitive overlap", () =>
    expect(
      run(
        [f("capability", "care")],
        [f("capability", "care", true)],
        {
          documentSimilarity: 0.2,
          reviewRequired: true,
          semanticReview: { compatible: false, confidence: 0.95, reason: "specialist work is unsupported" },
        },
      ).reason,
    ).toBe("insufficient_capability_evidence"));
    it("keeps a truly missing mandatory resource as a hard reject", () =>
      expect(
        run(
          [f("capability", "delivery")],
          [f("capability", "delivery"), f("resource", "van", true)],
        ).reason,
      ).toBe("missing_mandatory_resource"));
  it("rejects a typed mandatory resource independent of similarity", () =>
    expect(
      run(
        [f("capability", "moving")],
        [{ ...f("resource", "lift", true), resourceRole: "required" }],
        { documentSimilarity: 1 },
      ).reason,
    ).toBe("missing_mandatory_resource"));
  it("does not require a customer-provided resource from the executor", () =>
    expect(
      run(
        [f("capability", "assembly")],
        [{ ...f("resource", "drill", true), resourceRole: "provided_by_customer" }],
      ).reason,
    ).not.toBe("missing_mandatory_resource"));
  it("rejects a mandatory resource when typed capacity is insufficient", () =>
    expect(
      run(
        [{ ...f("resource", "vehicle"), resourceRole: "available", resourceCapacity: { value: 1, unit: "volume", kind: "capacity" } }],
        [{ ...f("resource", "vehicle", true), resourceRole: "required", resourceCapacity: { value: 3, unit: "volume", kind: "capacity" } }],
      ).reason,
    ).toBe("missing_mandatory_resource"));
  it("enforces typed availability constraints", () =>
    expect(
      run(
        [{ ...f("availability", "weekdays"), constraintType: "availability", startHour: 18, endHour: 20 }],
        [],
        { localHour: 10 },
      ).reason,
    ).toBe("outside_availability"));
  it("does not elevate an optional excluded component to a whole-task reject", () =>
    expect(
      run(
        [{ ...f("exclude", "windows"), constraintType: "exclusion", constraintScope: "optional_component" }, f("capability", "cleaning")],
        [{ ...f("capability", "cleaning") }],
      ).matchType,
    ).not.toBeNull());
  it("handles missing/zero/different-dimensional vectors", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1], [1, 0])).toBe(0);
    expect(cosine(null, [1, 0])).toBe(0);
  });
  it("compares the requested source time window with evening-only availability",()=>{
    expect(run([f("capability","loading"),{...f("availability",""),startHour:18,endHour:23}], [f("capability","loading"),{...f("availability",""),startHour:8,endHour:12}]).reason).toBe("outside_availability");
  });
});
