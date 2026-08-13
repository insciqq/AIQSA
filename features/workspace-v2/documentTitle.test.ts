import { describe, expect, it } from "vitest";
import { documentTitleV2 } from "./documentTitle";

describe("Document title v2", () => {
  it("follows the visible active chat, including renames", () => {
    expect(documentTitleV2({
      activeChatId: "chat-1",
      activeChatTitle: "Release checklist",
      libraryOpen: false
    })).toBe("Release checklist · AIQSA");

    expect(documentTitleV2({
      activeChatId: "chat-1",
      activeChatTitle: "Renamed checklist",
      libraryOpen: false
    })).toBe("Renamed checklist · AIQSA");
  });

  it("falls back to New chat on the blank workspace", () => {
    expect(documentTitleV2({
      activeChatId: null,
      activeChatTitle: "New Chat",
      libraryOpen: false
    })).toBe("New chat · AIQSA");

    expect(documentTitleV2({
      activeChatId: "chat-1",
      activeChatTitle: "   ",
      libraryOpen: false
    })).toBe("New chat · AIQSA");
  });

  it("lets the Library replace the title while it owns the workspace", () => {
    expect(documentTitleV2({
      activeChatId: "chat-1",
      activeChatTitle: "Release checklist",
      libraryOpen: true
    })).toBe("Библиотека · AIQSA");
  });
});
