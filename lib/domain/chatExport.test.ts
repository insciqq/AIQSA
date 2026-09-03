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
});
