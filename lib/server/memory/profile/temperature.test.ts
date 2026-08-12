import { describe, expect, it } from "vitest";
import { calculateMemoryTemperature } from "./temperature";

const asOf = new Date("2026-08-11T12:00:00.000Z");
const base = {
  asOf,
  confidence: 0.8,
  importance: 0.2,
  lastConfirmedAt: null,
  lastUsedAt: null,
  modality: "EVENT" as const,
  pinned: false,
  sourceMode: "AUTOMATIC" as const,
  validFrom: null,
  validTo: null
};

describe("Memory working-set temperature", () => {
  it("keeps pinning a ranking projection rather than a truth transition", () => {
    expect(calculateMemoryTemperature({ ...base, pinned: true })).toEqual({
      temperatureClass: "HOT",
      temperatureScore: 1
    });
  });

  it("makes current constraints and recently used facts hot deterministically", () => {
    expect(calculateMemoryTemperature({
      ...base,
      confidence: 1,
      importance: 0.8,
      lastUsedAt: new Date("2026-08-10T12:00:00.000Z"),
      modality: "CONSTRAINT",
      sourceMode: "EXPLICIT"
    })).toEqual({ temperatureClass: "HOT", temperatureScore: 0.86 });
  });

  it("keeps stable explicit preferences warm without expiring them by age", () => {
    expect(calculateMemoryTemperature({
      ...base,
      confidence: 1,
      importance: 0.5,
      modality: "PREFERENCE",
      sourceMode: "EXPLICIT"
    })).toEqual({ temperatureClass: "WARM", temperatureScore: 0.5 });
  });

  it("projects not-yet-valid and elapsed versions as cold without changing lifecycle", () => {
    expect(calculateMemoryTemperature({
      ...base,
      validFrom: new Date("2026-08-12T00:00:00.000Z")
    })).toEqual({ temperatureClass: "COLD", temperatureScore: 0 });
    expect(calculateMemoryTemperature({
      ...base,
      validTo: new Date("2026-08-11T12:00:00.000Z")
    })).toEqual({ temperatureClass: "COLD", temperatureScore: 0 });
  });
});
