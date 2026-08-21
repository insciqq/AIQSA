import {
  MEMORY_UI_LOCALE,
  MEMORY_UI_COPY_KEYS,
  formatMemoryUiCopy,
  memoryCategoryLabel,
  memoryUiCopy
} from "./memoryUiCopy";
import { describe, expect, it } from "vitest";

describe("Memory UI copy", () => {
  it("has non-blank English coverage without fallback", () => {
    for (const key of MEMORY_UI_COPY_KEYS) {
      expect(memoryUiCopy(key).trim(), key).not.toBe("");
    }
  });

  it("formats Memory-only labels through the same copy catalog", () => {
    expect(MEMORY_UI_LOCALE).toBe("en-US");
    expect(formatMemoryUiCopy("source.heading", { count: 2 })).toBe("Memory · 2");
    expect(formatMemoryUiCopy("action.matchIndex", { index: 3 })).toBe("Match 3");
    expect(memoryCategoryLabel("about_you")).toBe("About you");
    expect(memoryCategoryLabel("constraints_and_routines")).toBe("Constraints and routines");
    expect(memoryCategoryLabel("sensitive_information")).toBe("Other");
    expect(memoryCategoryLabel("unknown-category")).toBe("Other");
    expect(memoryUiCopy("manager.statementHelp")).not.toContain("exactly as entered");
    expect(memoryUiCopy("manager.unavailable")).toContain("temporarily unavailable");
  });
});
