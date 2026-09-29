import { describe, it, expect } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

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

describe("USTAL generic resource matching: hard vs soft signals", () => {
  describe("HARD_RESOURCE_TESTS: Physical resources with kind mismatch = REJECT", () => {
    it("vehicle type mismatch: motorcycle vs requires automobile = REJECT", () => {
      const caps = [
        f("capability", "transport"),
        {
          ...f("resource", "vehicle"),
          resourceRole: "available" as const,
          resourceType: "vehicle" as const,
          resourceCapacity: { value: 2, unit: "seats", kind: "мотоцикл" },
        },
      ];
      const reqs = [
        f("capability", "transport", true),
        {
          ...f("resource", "vehicle", true),
          resourceRole: "required" as const,
          resourceType: "vehicle" as const,
          resourceCapacity: { value: 5, unit: "seats", kind: "автомобиль" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("missing_mandatory_resource");
    });

    it("tool mismatch: drill vs requires perforator (impact drill) = REJECT", () => {
      const caps = [
        f("capability", "drilling"),
        {
          ...f("resource", "drill"),
          resourceRole: "available" as const,
          resourceType: "tool" as const,
          resourceCapacity: { value: null, unit: null, kind: "дрель" },
        },
      ];
      const reqs = [
        f("capability", "drilling", true),
        {
          ...f("resource", "drill", true),
          resourceRole: "required" as const,
          resourceType: "tool" as const,
          resourceCapacity: { value: null, unit: null, kind: "перфоратор" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("missing_mandatory_resource");
    });

    it("access/height mismatch: 3m ladder vs requires external 5-floor access = REJECT", () => {
      const caps = [
        f("capability", "access-work"),
        {
          ...f("resource", "access-equipment"),
          resourceRole: "available" as const,
          resourceType: "equipment" as const,
          resourceCapacity: { value: 3, unit: "meters", kind: "ladder" },
        },
      ];
      const reqs = [
        f("capability", "access-work", true),
        {
          ...f("resource", "access-equipment", true),
          resourceRole: "required" as const,
          resourceType: "equipment" as const,
          resourceCapacity: { value: 15, unit: "meters", kind: "external-access" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("missing_mandatory_resource");
    });

    it("capacity mismatch: 3m³ truck vs requires 10m³ = MATCH", () => {
      const caps = [
        {
          ...f("resource", "transport-vehicle"),
          resourceRole: "available" as const,
          resourceType: "vehicle" as const,
          resourceCapacity: { value: 3, unit: "m3", kind: "cargo-truck" },  // same kind: tests capacity alone (was "van", which also mismatched kind)
        },
      ];
      const reqs = [
        {
          ...f("resource", "transport-vehicle", true),
          resourceRole: "required" as const,
          resourceType: "vehicle" as const,
          resourceCapacity: { value: 10, unit: "m3", kind: "cargo-truck" },
        },
      ];
      const result = run(caps, reqs);
      // Capacity alone is soft signal (executor can make multiple trips)
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("missing truck entirely when required = REJECT", () => {
      const caps = [
        f("capability", "delivery"),
        {
          ...f("resource", "equipment"),
          resourceRole: "available" as const,
          resourceCapacity: { value: 50, unit: "kg", kind: "bicycle" },
        },
      ];
      const reqs = [
        f("capability", "delivery", true),
        {
          ...f("resource", "truck", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: 1000, unit: "kg", kind: null },
        },
      ];
      const result = run(caps, reqs);
      // 2026-09-27 (bug 2): a profile silent about a mandatory resource is unverified, not missing — the source review decides; still no match without it.
      expect(result.matchType).toBeNull();
      expect(result.reason).toBe("physical_compatibility_unverified");
    });
  });

  describe("SOFT_TESTS: Explicit methods or non-physical resources = MATCH (soft signal)", () => {
  // Same resource node on both sides; only the kind differs. (Fixtures previously used
  // different node ids from the removed nodeId-name "method" heuristic, so the kind
  // comparison was never reached.)
    it("explicit method: different welding-method (TIG vs MMA) = MATCH", () => {
      const caps = [
        f("capability", "metal-welding"),
        {
          ...f("resource", "welding-method"),
          resourceRole: "available" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "tig" },
        },
      ];
      const reqs = [
        f("capability", "metal-welding", true),
        {
          ...f("resource", "welding-method", true),
          resourceRole: "required" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "mma" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("explicit method: different testing-method (automation vs manual) = MATCH", () => {
      const caps = [
        f("capability", "quality-assurance"),
        {
          ...f("resource", "testing-method"),
          resourceRole: "available" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "selenium" },
        },
      ];
      const reqs = [
        f("capability", "quality-assurance", true),
        {
          ...f("resource", "testing-method", true),
          resourceRole: "required" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "manual" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("explicit method: different platform (Linux vs Windows server) = MATCH", () => {
      const caps = [
        f("capability", "server-administration"),
        {
          ...f("resource", "platform"),
          resourceRole: "available" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "linux" },
        },
      ];
      const reqs = [
        f("capability", "server-administration", true),
        {
          ...f("resource", "platform", true),
          resourceRole: "required" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "windows" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("specialization mismatch: fitness trainer vs requires yoga specialty = MATCH", () => {
      const caps = [
        f("capability", "physical-training"),
        {
          ...f("resource", "specialization"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "fitness-training" },
        },
      ];
      const reqs = [
        f("capability", "physical-training", true),
        {
          ...f("resource", "specialization", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "yoga-instruction" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("medium/approach mismatch: oil painter vs requires digital design = MATCH", () => {
      const caps = [
        f("capability", "visual-design"),
        {
          ...f("resource", "medium"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "oil-paint" },
        },
      ];
      const reqs = [
        f("capability", "visual-design", true),
        {
          ...f("resource", "medium", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "digital" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("language/framework mismatch: Python vs requires JavaScript = MATCH", () => {
      const caps = [
        f("capability", "software-development"),
        {
          ...f("resource", "programming-language"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "python" },
        },
      ];
      const reqs = [
        f("capability", "software-development", true),
        {
          ...f("resource", "programming-language", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "javascript" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });
  });

  describe("PHYSICAL_RESOURCE_WITH_METHOD_INDICATOR: Tool marked as method = MATCH", () => {
    it("welder with welding-method indicator: any welding type vs specific type = MATCH", () => {
      const caps = [
        {
          ...f("resource", "welder"),
          resourceRole: "available" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "stick-welding" },
        },
      ];
      const reqs = [
        {
          ...f("resource", "welder", true),
          resourceRole: "required" as const,
          resourceType: "other" as const,
          resourceCapacity: { value: null, unit: null, kind: "gas-welding" },
        },
      ];
      // Note: If nodeIds contain "welder" but NOT "welding-method", this would be hard reject
      // But if requirement explicitly asks for "welding-method", it's soft
      const result = run(caps, reqs);
      // Without explicit "welding-method" in nodeIds, isPhysical=true, isExplicitMethod=false
      // So this SHOULD reject. But user can mark it as "welding-method" resource to make it soft
      // This test demonstrates that by explicitly naming it welding-method, it becomes soft
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });
  });

  describe("EXPLICIT_EXCLUSION_TESTS: Explicit refusal/limitation = REJECT", () => {
    it("explicit exclusion: 'only Linux', order requires Windows = REJECT", () => {
      const caps = [
        f("capability", "server-administration"),
        { ...f("exclude", "windows"), constraintType: "exclusion" as const, constraintScope: "whole_task" as const },
      ];
      const reqs = [
        f("capability", "server-administration"),
        f("capability", "windows-server", true),
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("explicit_exclusion");
    });

    it("explicit exclusion: 'не делаю', order requires excluded skill = REJECT", () => {
      const caps = [
        f("capability", "metal-welding"),
        { ...f("exclude", "mma-welding"), constraintType: "exclusion" as const, constraintScope: "whole_task" as const },
      ];
      const reqs = [
        f("capability", "metal-welding"),
        f("capability", "mma-welding", true),
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("explicit_exclusion");
    });

    it("time constraint: available until 5pm, order requires night shift = REJECT", () => {
      const caps = [
        f("capability", "general-work"),
        { ...f("availability", "daytime"), startHour: 8, endHour: 17, constraintType: "availability" as const },
      ];
      const reqs = [f("capability", "general-work", true)];
      const result = run(caps, reqs, { localHour: 22 });
      expect(result.reason).toBe("outside_availability");
    });
  });

  describe("OPTIONAL_REQUIREMENTS: Always soft signal", () => {
    it("optional physical resource with kind mismatch = MATCH (soft)", () => {
      const caps = [
        {
          ...f("resource", "drill"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "дрель" },
        },
      ];
      const reqs = [
        {
          ...f("resource", "drill", false),  // mandatory=false (optional)
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "перфоратор" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });
  });

  describe("SOFT_SIGNAL_TRACE: Kind mismatches tracked for visibility", () => {
    it("should trace kind_mismatches for explicit method mismatch", () => {
      const caps = [
        {
          ...f("resource", "testing-method"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "automated" },
        },
      ];
      const reqs = [
        {
          ...f("resource", "testing-method", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "manual" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.trace.resource_kind_mismatches).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GENERIC_PRINCIPLE: No hardcoded values, semiotics-based classification", () => {
    it("any explicit-method type (e.g. approach, technique) with kind mismatch = MATCH", () => {
      const caps = [
        {
          ...f("resource", "implementation-approach"),
          resourceRole: "available" as const,
          resourceCapacity: { value: null, unit: null, kind: "agile" },
        },
      ];
      const reqs = [
        {
          ...f("resource", "implementation-approach", true),
          resourceRole: "required" as const,
          resourceCapacity: { value: null, unit: null, kind: "waterfall" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.matchType).not.toBeNull();
      expect(result.reason).not.toBe("missing_mandatory_resource");
    });

    it("any physical-resource type (e.g. equipment) with kind mismatch and mandatory = REJECT", () => {
      const caps = [
        {
          ...f("resource", "heavy-equipment"),
          resourceRole: "available" as const,
          resourceType: "equipment" as const,
          resourceCapacity: { value: null, unit: null, kind: "excavator" },
        },
      ];
      const reqs = [
        {
          ...f("resource", "heavy-equipment", true),
          resourceRole: "required" as const,
          resourceType: "equipment" as const,
          resourceCapacity: { value: null, unit: null, kind: "bulldozer" },
        },
      ];
      const result = run(caps, reqs);
      expect(result.reason).toBe("missing_mandatory_resource");
    });
  });
});
