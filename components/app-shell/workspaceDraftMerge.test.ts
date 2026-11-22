import { describe, expect, it } from "vitest";
import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import { mergeWorkspaceDrafts, nextChatAfterRemoval } from "./workspaceDraftMerge";

function summary(input: Partial<WorkspaceChatSummary> & Pick<WorkspaceChatSummary, "id">): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    defaultModelId: "model-1",
    defaultProvider: "provider-1",
    folderId: null,
    messageCount: 0,
    title: input.id,
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...input
  };
}

describe("workspace draft reconciliation", () => {
  it("keeps an acknowledged change against an older read and takes a newer one", () => {
    const current = summary({ id: "chat-1", title: "Renamed", updatedAt: "2026-08-22T00:00:01.000Z" });
    const stale = summary({ id: current.id, title: "Old title" });
    const merged = mergeWorkspaceDrafts({ currentChats: [current], incomingChats: [stale] });
    expect(merged.chats[0]).toMatchObject({ title: "Renamed", updatedAt: current.updatedAt });

    const newer = { ...stale, title: "Newest", updatedAt: "2026-08-22T00:00:02.000Z" };
    expect(mergeWorkspaceDrafts({ currentChats: merged.chats, incomingChats: [newer] }).chats[0])
      .toMatchObject({ title: "Newest", updatedAt: newer.updatedAt });
  });

  it("preserves a personal first-send reservation and promotes its persisted row", () => {
    const draft = summary({
      folderId: "folder-1",
      id: "personal-draft-1",
      pendingPersonalDraft: { folderId: "folder-1", memoryMode: "NORMAL" },
      title: "Local personal draft"
    });

    expect(mergeWorkspaceDrafts({ currentChats: [draft], incomingChats: [] }).chats).toEqual([draft]);

    const promoted = mergeWorkspaceDrafts({
      currentChats: [draft],
      incomingChats: [{ ...draft, messageCount: 2, pendingPersonalDraft: undefined, title: "Persisted personal chat" }]
    });
    expect(promoted.chats).toHaveLength(1);
    expect(promoted.chats[0]).toMatchObject({
      id: draft.id,
      messageCount: 2,
      pendingPersonalDraft: undefined,
      title: "Persisted personal chat"
    });
  });

  it("drops a saved chat the server no longer lists", () => {
    const removed = summary({ id: "personal-removed" });
    const personal = summary({ id: "personal-1" });
    expect(mergeWorkspaceDrafts({ currentChats: [removed], incomingChats: [personal] }).chats.map((chat) => chat.id))
      .toEqual(["personal-1"]);
  });

  it("replaces a removed chat with another chat or the blank chat", () => {
    const chats = [
      summary({ id: "personal-draft", pendingPersonalDraft: { folderId: null, memoryMode: "NORMAL" } }),
      summary({ id: "personal-1" })
    ];
    expect(nextChatAfterRemoval(chats, "personal-1")?.id).toBe("personal-draft");
    expect(nextChatAfterRemoval([chats[1]!], "personal-1")).toBeNull();
  });
});
