import { describe, expect, it } from "vitest";
import { favoriteOnlyChatUpdate } from "./prismaRepository";

describe("favoriteOnlyChatUpdate", () => {
  it("keeps the chat's time only for a change of the favorite flag alone", () => {
    expect(favoriteOnlyChatUpdate({ pinned: true })).toBe(true);
    expect(favoriteOnlyChatUpdate({ pinned: false })).toBe(true);
    // The PATCH route passes an absent or blank title as null.
    expect(favoriteOnlyChatUpdate({ pinned: true, title: null })).toBe(true);

    expect(favoriteOnlyChatUpdate({})).toBe(false);
    for (const other of [
      { activeLeafMessageId: "message-1" },
      { activeLeafMessageId: null },
      { assistantId: null },
      { assistantOverrides: {} },
      { defaultSearchPlan: null },
      { folderId: null },
      { folderId: "folder-1" },
      { title: "Renamed" },
      { workspaceEnabled: false }
    ]) {
      expect(favoriteOnlyChatUpdate({ pinned: true, ...other })).toBe(false);
    }
  });
});
