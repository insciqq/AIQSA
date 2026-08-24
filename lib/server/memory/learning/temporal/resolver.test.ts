import { describe, expect, it } from "vitest";
import {
  MemoryTemporalError,
  resolveMemoryTemporal,
  type MemoryTemporalProposal
} from "./resolver";

const empty: MemoryTemporalProposal = {
  expectedAt: null,
  expiresAt: null,
  occurredAt: null,
  rawExpression: null,
  validFrom: null,
  validTo: null
};

describe("Memory vNext temporal resolver", () => {
  const observedAt = new Date("2026-08-24T10:00:00.000Z");

  it("resolves relative occurrence against the captured IANA timezone", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: { ...empty, rawExpression: "вчера" },
      sourceText: "Я вчера купил ноутбук.",
      timeZone: "Europe/Moscow"
    });
    expect(result.occurredAt).toBe("2026-08-22T21:00:00.000Z");
    expect(result.expectedAt).toBeNull();
    expect(result.resolutionEvidence).toMatchObject({
      resolverVersion: "memory-temporal-resolution-v2",
      timeZone: "Europe/Moscow"
    });
  });

  it("derives expiration only from exact TTL wording and uses inclusive weekdays", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: {
        ...empty,
        rawExpression: "remember this until Friday"
      },
      sourceText: "Please remember this until Friday: I am in Berlin.",
      timeZone: "Europe/Moscow"
    });
    // Friday is included, so the fence begins at Saturday local midnight.
    expect(result.expiresAt).toBe("2026-08-28T21:00:00.000Z");
    expect(result.resolutionEvidence).toMatchObject({ expiryExplicit: true });
  });

  it("resolves an explicit date through the user's local calendar", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: { ...empty, rawExpression: "remember until 2026-08-30" },
      sourceText: "Please remember until 2026-08-30 that I am travelling.",
      timeZone: "Europe/Moscow"
    });
    expect(result.expiresAt).toBe("2026-08-30T21:00:00.000Z");
  });

  it("accepts bounded Russian TTL wording and rejects model/deterministic conflicts", () => {
    const result = resolveMemoryTemporal({
      observedAt,
      proposal: { ...empty, rawExpression: "Запомни этот код до пятницы" },
      sourceText: "Запомни этот код до пятницы: обычная заметка.",
      timeZone: "Europe/Moscow"
    });
    expect(result.expiresAt).toBe("2026-08-28T21:00:00.000Z");

    expect(() => resolveMemoryTemporal({
      observedAt,
      proposal: {
        ...empty,
        occurredAt: "2026-08-24T00:00:00Z",
        rawExpression: "вчера"
      },
      sourceText: "Я вчера купил ноутбук.",
      timeZone: "Europe/Moscow"
    })).toThrow(MemoryTemporalError);
  });

  it("rejects guessed expiration, missing exact expressions and invalid intervals", () => {
    expect(() => resolveMemoryTemporal({
      observedAt,
      proposal: {
        ...empty,
        expiresAt: "2026-08-30T00:00:00Z",
        rawExpression: "I am travelling"
      },
      sourceText: "I am travelling for work.",
      timeZone: "UTC"
    })).toThrow(MemoryTemporalError);
    expect(() => resolveMemoryTemporal({
      observedAt,
      proposal: { ...empty, expiresAt: "2026-08-30T00:00:00Z" },
      sourceText: "Remember this until 2026-08-30.",
      timeZone: "UTC"
    })).toThrow(MemoryTemporalError);
    expect(() => resolveMemoryTemporal({
      observedAt,
      proposal: {
        ...empty,
        rawExpression: "from Tuesday to Monday",
        validFrom: "2026-08-30T00:00:00Z",
        validTo: "2026-08-29T00:00:00Z"
      },
      sourceText: "This applies from Tuesday to Monday.",
      timeZone: "UTC"
    })).toThrow(MemoryTemporalError);
  });
});
