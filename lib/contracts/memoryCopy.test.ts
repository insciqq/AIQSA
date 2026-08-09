import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_COPY,
  MEMORY_COPY_KEYS,
  MemoryCopyContractError,
  memoryCopyCatalogIsComplete,
  resolveMemoryCopy
} from "./memoryCopy";

describe("Memory RU/EN copy contract", () => {
  it("has exact key parity, non-empty values, and one versioned confirmation contract", () => {
    expect(MEMORY_CONFIRMATION_COPY_VERSION).toBe("memory-confirmation-v1");
    expect(memoryCopyCatalogIsComplete(MEMORY_COPY)).toBe(true);
    expect(Object.keys(MEMORY_COPY.RU).sort()).toEqual([...MEMORY_COPY_KEYS].sort());
    expect(Object.keys(MEMORY_COPY.EN).sort()).toEqual([...MEMORY_COPY_KEYS].sort());
  });

  it("keeps Archive, Exclude, Forget, permanent delete, and Temporary distinct", () => {
    for (const locale of ["RU", "EN"] as const) {
      const actions = [
        resolveMemoryCopy(locale, "archive.action"),
        resolveMemoryCopy(locale, "exclude.action"),
        resolveMemoryCopy(locale, "forget.action"),
        resolveMemoryCopy(locale, "permanentDelete.action"),
        resolveMemoryCopy(locale, "temporary.label")
      ];
      expect(new Set(actions).size).toBe(actions.length);
      expect(resolveMemoryCopy(locale, "archive.explanation"))
        .not.toBe(resolveMemoryCopy(locale, "exclude.explanation"));
      expect(resolveMemoryCopy(locale, "temporary.retention")).toContain("24");
      expect(resolveMemoryCopy(locale, "temporary.externalRetention").length).toBeGreaterThan(30);
    }
  });

  it("fails closed rather than falling back when any locale key is absent", () => {
    const incomplete = {
      EN: { ...MEMORY_COPY.EN },
      RU: { ...MEMORY_COPY.RU }
    } as Record<string, Record<string, string>>;
    delete incomplete.RU["forget.explanation"];
    expect(memoryCopyCatalogIsComplete(incomplete)).toBe(false);
    expect(() => resolveMemoryCopy("RU", "archive.action", incomplete))
      .toThrow(MemoryCopyContractError);
  });
});
