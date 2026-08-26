import { describe, expect, it } from "vitest";
import {
  resolveMemoryTemporal,
  type MemoryTemporalProposal
} from "./resolver";

const observedAt = new Date("2026-03-28T10:00:00.000Z");

function proposal(
  overrides: Partial<MemoryTemporalProposal> = {}
): MemoryTemporalProposal {
  return {
    expirationIntent: "NONE",
    normalization: { kind: "NONE" },
    perspective: "CURRENT",
    rawExpression: null,
    ...overrides
  };
}

describe("structured Memory temporal resolver", () => {
  it("performs calendar-day arithmetic in the source timezone across DST", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: proposal({
        normalization: { amount: 2, kind: "CALENDAR_OFFSET", unit: "DAY" },
        perspective: "FUTURE",
        rawExpression: "opaque temporal expression"
      }),
      timeZone: "Europe/Helsinki"
    });
    expect(result.expectedAt).toBe("2026-03-30T09:00:00.000Z");
    expect(result.occurredAt).toBeNull();
  });

  it("uses structured expiration intent and never phrase parsing", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: proposal({
        expirationIntent: "EXPLICIT",
        normalization: {
          kind: "ABSOLUTE",
          localDate: "2026-04-05",
          localTime: null,
          zone: null
        },
        rawExpression: "どんな綴りでも同じ"
      }),
      timeZone: "Asia/Tokyo"
    });
    expect(result.expiresAt).toBe("2026-04-04T15:00:00.000Z");
    expect(result.resolutionEvidence).toMatchObject({
      expirationIntent: "EXPLICIT",
      normalizationKind: "ABSOLUTE"
    });
  });

  it("resolves a structured relative weekday without weekday names", () => {
    const result = resolveMemoryTemporal({
      observedAt: new Date("2026-08-25T09:00:00.000Z"),
      proposal: proposal({
        normalization: {
          direction: "NEXT",
          kind: "RELATIVE_WEEKDAY",
          weekday: 5
        },
        perspective: "FUTURE",
        rawExpression: "opaque"
      }),
      timeZone: "UTC"
    });
    expect(result.expectedAt).toBe("2026-08-28T00:00:00.000Z");
  });

  it("normalizes structured intervals and preserves ordering", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: proposal({
        normalization: {
          end: { amount: 2, kind: "CALENDAR_OFFSET", unit: "WEEK" },
          kind: "INTERVAL",
          start: { amount: 1, kind: "CALENDAR_OFFSET", unit: "WEEK" }
        },
        perspective: "INTERVAL",
        rawExpression: "opaque"
      }),
      timeZone: "UTC"
    });
    expect(result.validFrom).toBe("2026-04-04T10:00:00.000Z");
    expect(result.validTo).toBe("2026-04-11T10:00:00.000Z");
  });

  it("degrades invalid optional time to null instead of rejecting the fact", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: proposal({
        normalization: {
          kind: "ABSOLUTE",
          localDate: "2026-02-31",
          localTime: null,
          zone: null
        },
        perspective: "EVENT",
        rawExpression: "opaque"
      }),
      timeZone: "UTC"
    });
    expect(result).toMatchObject({
      expectedAt: null,
      expiresAt: null,
      occurredAt: null,
      validFrom: null,
      validTo: null
    });
    expect(result.resolutionEvidence).toMatchObject({ resolution: "INVALID" });
  });
});
