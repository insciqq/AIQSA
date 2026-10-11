import {
  MEMORY_UI_LOCALE,
  MEMORY_UI_COPY_KEYS,
  formatMemoryUiCopy,
  memoryCategoryLabel,
  memoryEmptyListDescriptionKey,
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
    expect(memoryCategoryLabel("constraints_routines")).toBe("Constraints and routines");
    expect(memoryCategoryLabel("constraints_and_routines")).toBe("Constraints and routines");
    expect(memoryCategoryLabel("sensitive_information")).toBe("Other");
    expect(memoryCategoryLabel("unknown-category")).toBe("Other");
    expect(memoryUiCopy("manager.statementHelp")).not.toContain("exactly as entered");
  });

  it("keeps no copy that announces a Memory failure, limit or load error", () => {
    for (const key of MEMORY_UI_COPY_KEYS) {
      const copy = memoryUiCopy(key);
      expect(copy, key).not.toMatch(/temporarily unavailable|could not be (?:confirmed|completed|loaded|opened|saved)|not applied|limitations|source unavailable/iu);
    }
    expect(memoryUiCopy("answer.preparationFailed")).not.toMatch(/memory/iu);
    expect(memoryUiCopy("manager.reload")).toBe("Reload");
    expect(memoryUiCopy("settings.reload")).toBe("Reload");
  });

  it("offers an empty list only actions that work in the current Memory state", () => {
    const description = (status: string | null, automaticLearning = true) =>
      memoryUiCopy(memoryEmptyListDescriptionKey({ automaticLearning, status }));
    const askInChat = /remember that/u;
    const writeYourself = /write (?:the first|a) fact yourself/iu;

    expect(description("ON")).toMatch(askInChat);
    expect(description("ON", false)).toMatch(askInChat);
    expect(description("ON", false)).toMatch(/Automatic learning is off/u);
    for (const status of ["PAUSED", "NEEDS_ADMIN_SETUP", "UNAVAILABLE", "PREPARING", null]) {
      expect(description(status), String(status)).not.toMatch(askInChat);
      expect(description(status), String(status)).toMatch(writeYourself);
    }
    expect(description("PAUSED")).toMatch(/Memory is paused/u);
    expect(description("NEEDS_ADMIN_SETUP")).toMatch(/administrator setup/u);
    // Unavailability is never diagnosed to the user.
    expect(description("UNAVAILABLE")).not.toMatch(/unavailable|error|failed|administrator/iu);
  });
});
