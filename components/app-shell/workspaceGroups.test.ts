import { describe, expect, it } from "vitest";
import type { WorkspaceChatSummary } from "./types";
import { buildChatGroups } from "./workspaceGroups";

function chat(input: Partial<WorkspaceChatSummary> & { id: string; title: string }): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    messageCount: 0,
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...input
  };
}

describe("workspace chat groups", () => {
  it("includes server-side content matches for unloaded chats", () => {
    const chats = [
      chat({ id: "chat-title", title: "Architecture notes" }),
      chat({ id: "chat-content", title: "Untitled import" }),
      chat({ id: "chat-miss", title: "Dinner" })
    ];
    const groups = buildChatGroups(
      [],
      chats,
      "buried phrase",
      new Set(["chat-content"])
    );
    const titleGroups = buildChatGroups([], chats, "architecture", new Set());

    expect(groups).toHaveLength(1);
    expect(groups[0]?.chats.map((candidate) => candidate.id)).toEqual(["chat-content"]);
    expect(titleGroups[0]?.chats.map((candidate) => candidate.id)).toEqual([
      "chat-title"
    ]);
  });

  it("keeps thread bodies out of local summary filtering", () => {
    const loaded = chat({
      activeLeafMessageId: "message-1",
      id: "chat-loaded",
      messageCount: 1,
      title: "Untitled import"
    });

    expect(buildChatGroups([], [loaded], "buried local phrase", new Set())).toEqual([]);
    expect(
      buildChatGroups([], [loaded], "buried local phrase", new Set([loaded.id]))[0]
        ?.chats
    ).toEqual([loaded]);
  });

  it("retains ancestor folders when only a nested chat matches", () => {
    const folders = [
      {
        id: "parent",
        name: "Research",
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      },
      {
        id: "child",
        name: "Sources",
        parentId: "parent",
        projectMemory: "",
        sortOrder: 0
      }
    ];
    const nested = chat({
      folderId: "child",
      id: "chat-nested",
      title: "Architecture notes"
    });

    const groups = buildChatGroups(folders, [nested], "architecture", new Set());

    expect(
      groups.map((group) => [
        group.name,
        group.depth,
        group.chats.map((candidate) => candidate.id)
      ])
    ).toEqual([
      ["Research", 0, []],
      ["Sources", 1, ["chat-nested"]]
    ]);
  });
});
