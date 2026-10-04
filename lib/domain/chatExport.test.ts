import { describe, expect, it } from "vitest";
import { chatExportFileBaseName, chatExportMarkdown, chatExportText } from "./chatExport";

describe("chat export documents", () => {
  it("renders the visible branch as User/Assistant turns under the title", () => {
    expect(chatExportMarkdown("Release checklist", [
      { content: { blocks: [{ text: "Ship it?", type: "text" }] }, role: "user" },
      { content: "Yes.\n", role: "assistant" }
    ])).toBe("# Release checklist\n\n## User\n\nShip it?\n\n## Assistant\n\nYes.\n");
  });

  it("keeps only text blocks and tolerates foreign content shapes", () => {
    expect(chatExportText({
      blocks: [
        { attachmentId: "a1", type: "image" },
        { text: "first", type: "text" },
        { text: 42, type: "text" },
        { text: "second", type: "text" }
      ]
    })).toBe("first\nsecond");
    expect(chatExportText(null)).toBe("");
    expect(chatExportText(["text"])).toBe("");
  });

  it("derives a stable slug-and-date base name", () => {
    const date = new Date("2026-09-01T10:00:00.000Z");
    expect(chatExportFileBaseName("Release checklist · 032", date)).toBe("release-checklist-032-2026-09-01");
    expect(chatExportFileBaseName("   ", date)).toBe("chat-2026-09-01");
  });

  it("cuts a slug on code points within a UTF-8 budget, never inside a surrogate pair", () => {
    const date = new Date("2026-09-01T10:00:00.000Z");
    // One BMP letter first puts a UTF-16 cut inside a pair; 4-byte letters fill the 72-byte budget.
    const astral = chatExportFileBaseName(`a${"𠜎".repeat(100)}`, date);
    expect(astral).toBe(`a${"𠜎".repeat(17)}-2026-09-01`);
    expect(() => encodeURIComponent(astral)).not.toThrow();
    expect(chatExportFileBaseName("д".repeat(80), date)).toBe(`${"д".repeat(36)}-2026-09-01`);
    expect(chatExportFileBaseName("x".repeat(80), date)).toBe(`${"x".repeat(64)}-2026-09-01`);
    // The longest bulk entry name still fits a 100-byte ustar name.
    expect(new TextEncoder().encode(`${chatExportFileBaseName("я".repeat(80), date)}-100000.json`).length).toBeLessThanOrEqual(100);
  });
});
