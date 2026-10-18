import { describe, it, expect } from "vitest";
import { capabilityExtractionResultSchema } from "./profile.js";

describe("capabilityExtractionResultSchema", () => {
  it("should accept material as valid resourceType", () => {
    const validInput = {
      summary: "Mason with various materials",
      capabilities: [],
      resources: [
        {
          label: "Cement and sand",
          resourceType: "material",
          attributes: {
            quantity: "100 kg",
            location: "storage",
          },
          evidenceType: "explicit",
          confidence: 0.95,
        },
      ],
    };

    const result = capabilityExtractionResultSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("should accept all resource types including material", () => {
    const resourceTypes = [
      "vehicle",
      "tool",
      "equipment",
      "material",
      "property",
      "space",
      "audience",
      "digital_asset",
      "other",
    ];

    for (const type of resourceTypes) {
      const validInput = {
        summary: "Test profile",
        capabilities: [],
        resources: [
          {
            label: `Resource of type ${type}`,
            resourceType: type,
            attributes: {},
            evidenceType: "explicit",
            confidence: 0.8,
          },
        ],
      };

      const result = capabilityExtractionResultSchema.safeParse(validInput);
      expect(result.success, `resourceType '${type}' should be valid`).toBe(true);
    }
  });

  it("should reject unknown resourceType", () => {
    const invalidInput = {
      summary: "Test",
      capabilities: [],
      resources: [
        {
          label: "Invalid",
          resourceType: "unknown_type",
          attributes: {},
          evidenceType: "explicit",
          confidence: 0.8,
        },
      ],
    };

    const result = capabilityExtractionResultSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it("should validate material with typical attributes", () => {
    const validInput = {
      summary: "Painter with paint supplies",
      capabilities: [
        {
          label: "Interior painting",
          proficiency: "professional",
          evidenceType: "completed_order",
          confidence: 0.95,
        },
      ],
      resources: [
        {
          label: "Acrylic paint",
          resourceType: "material",
          attributes: {
            type: "paint",
            volume_liters: 20,
            color_variety: true,
          },
          evidenceType: "explicit",
          confidence: 0.9,
        },
        {
          label: "Brushes and rollers",
          resourceType: "tool",
          attributes: {
            count: 15,
            types: "brush, roller, sponge",
          },
          evidenceType: "explicit",
          confidence: 0.85,
        },
      ],
    };

    const result = capabilityExtractionResultSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("should validate comprehensive profile with multiple resources", () => {
    const validInput = {
      summary: "Multi-skilled professional with diverse equipment",
      capabilities: [
        {
          label: "Painting services",
          proficiency: "professional",
          evidenceType: "completed_order",
          confidence: 0.95,
        },
        {
          label: "Carpentry",
          proficiency: "experienced",
          evidenceType: "explicit",
          confidence: 0.85,
        },
      ],
      resources: [
        {
          label: "Acrylic paint",
          resourceType: "material",
          attributes: {
            type: "paint",
            volume_liters: 20,
            color_variety: true,
          },
          evidenceType: "explicit",
          confidence: 0.9,
        },
        {
          label: "Cement mix",
          resourceType: "material",
          attributes: {
            weight_kg: 50,
            coverage_sqm: 10.5,
          },
          evidenceType: "explicit",
          confidence: 0.88,
        },
        {
          label: "Power drill",
          resourceType: "equipment",
          attributes: {
            power_watts: 800,
            corded: true,
          },
          evidenceType: "explicit",
          confidence: 0.92,
        },
        {
          label: "Work vehicle",
          resourceType: "vehicle",
          attributes: {
            capacity_kg: 1000,
            year_manufactured: 2020,
          },
          evidenceType: "inferred",
          confidence: 0.75,
        },
      ],
    };

    const result = capabilityExtractionResultSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });
});
