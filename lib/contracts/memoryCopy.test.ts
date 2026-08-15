import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_COPY,
  MemoryCopyContractError,
  memoryCopyCatalogIsComplete,
  resolveMemoryCopy
} from "./memoryCopy";

describe("Memory presentation copy contract", () => {
  it("has complete non-empty copy and one versioned confirmation contract", () => {
    expect(MEMORY_CONFIRMATION_COPY_VERSION).toBe("memory-confirmation-v1");
    expect(memoryCopyCatalogIsComplete(MEMORY_COPY)).toBe(true);
  });

  it("keeps Archive, Exclude, Forget, permanent delete, and Temporary distinct", () => {
    const actions = [
      resolveMemoryCopy("archive.action"),
      resolveMemoryCopy("exclude.action"),
      resolveMemoryCopy("forget.action"),
      resolveMemoryCopy("permanentDelete.action"),
      resolveMemoryCopy("temporary.label")
    ];
    expect(new Set(actions).size).toBe(actions.length);
    expect(resolveMemoryCopy("archive.explanation"))
      .not.toBe(resolveMemoryCopy("exclude.explanation"));
    expect(resolveMemoryCopy("temporary.retention")).toContain("24");
    expect(resolveMemoryCopy("temporary.externalRetention").length).toBeGreaterThan(30);
  });

  it("fails closed rather than falling back when any presentation key is absent", () => {
    const incomplete = { ...MEMORY_COPY } as Record<string, string>;
    delete incomplete["forget.explanation"];
    expect(memoryCopyCatalogIsComplete(incomplete)).toBe(false);
    expect(() => resolveMemoryCopy("archive.action", incomplete))
      .toThrow(MemoryCopyContractError);
  });
});
