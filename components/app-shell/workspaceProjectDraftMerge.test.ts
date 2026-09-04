import { describe, expect, it } from "vitest";
import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import type { ProjectChatSummaryWire } from "@/lib/contracts/projects";
import { mergeWorkspaceProjectDrafts } from "./workspaceProjectDraftMerge";

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

function projectChat(input: Partial<ProjectChatSummaryWire> & Pick<ProjectChatSummaryWire, "id" | "projectId">): ProjectChatSummaryWire {
  return {
    activeLeafMessageId: null,
    activeRun: false,
    archived: false,
    createdAt: "2026-08-22T00:00:00.000Z",
    createdByDisplayName: "Operator",
    createdByUserId: "user-1",
    defaultKnowledgePlan: null,
    defaultModelId: "model-1",
    defaultProvider: "provider-1",
    folderId: null,
    messageCount: 0,
    pinned: false,
    title: input.id,
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...input
  };
}

describe("Project draft workspace reconciliation", () => {
  it("preserves a personal first-send reservation and promotes its persisted row", () => {
    const draft = summary({
      folderId: "folder-1",
      id: "personal-draft-1",
      pendingPersonalDraft: { folderId: "folder-1", memoryMode: "NORMAL" },
      projectId: null,
      title: "Local personal draft"
    });

    const retained = mergeWorkspaceProjectDrafts({
      currentChats: [draft],
      incomingChats: []
    });
    expect(retained.chats).toEqual([draft]);

    const promoted = mergeWorkspaceProjectDrafts({
      currentChats: [draft],
      incomingChats: [{
        ...draft,
        messageCount: 2,
        pendingPersonalDraft: undefined,
        title: "Persisted personal chat"
      }]
    });
    expect(promoted.chats).toHaveLength(1);
    expect(promoted.chats[0]).toMatchObject({
      id: draft.id,
      messageCount: 2,
      pendingPersonalDraft: undefined,
      title: "Persisted personal chat"
    });
  });

  it("preserves a valid local draft across a global workspace refresh", () => {
    const draft = summary({
      id: "draft-1",
      pendingProjectDraft: { folderId: "folder-1", projectId: "project-1" },
      projectId: "project-1"
    });
    const persisted = summary({ id: "personal-1", projectId: null });

    const merged = mergeWorkspaceProjectDrafts({
      currentChats: [draft],
      incomingChats: [persisted]
    });

    expect(merged.chats.map((chat) => chat.id).sort()).toEqual(["draft-1", "personal-1"]);
    expect(merged.chats.find((chat) => chat.id === draft.id)?.pendingProjectDraft)
      .toEqual(draft.pendingProjectDraft);
  });

  it("preserves a scoped draft in both stores without leaking another Project", () => {
    const selectedDraft = summary({
      id: "draft-selected",
      pendingProjectDraft: { folderId: null, projectId: "project-1" },
      projectId: "project-1"
    });
    const otherDraft = summary({
      id: "draft-other",
      pendingProjectDraft: { folderId: null, projectId: "project-2" },
      projectId: "project-2"
    });
    const selectedWire = projectChat({ id: selectedDraft.id, projectId: "project-1" });

    const merged = mergeWorkspaceProjectDrafts({
      currentChats: [selectedDraft, otherDraft],
      currentProjectChats: [selectedWire],
      incomingChats: [],
      incomingProjectChats: [],
      projectId: "project-1"
    });

    expect(merged.chats.map((chat) => chat.id).sort()).toEqual([
      "draft-other",
      "draft-selected"
    ]);
    expect(merged.projectChats?.map((chat) => chat.id)).toEqual(["draft-selected"]);
  });

  it("promotes a persisted chat with the same id and clears the draft without duplication", () => {
    const draft = summary({
      id: "draft-1",
      pendingProjectDraft: { folderId: "folder-1", projectId: "project-1" },
      projectId: "project-1",
      title: "Local draft"
    });
    const persisted = summary({
      id: draft.id,
      messageCount: 2,
      projectId: "project-1",
      title: "Persisted chat",
      updatedAt: "2026-08-22T01:00:00.000Z"
    });
    const persistedWire = projectChat({
      id: draft.id,
      messageCount: 2,
      projectId: "project-1",
      title: "Persisted chat"
    });

    const merged = mergeWorkspaceProjectDrafts({
      currentChats: [draft],
      currentProjectChats: [projectChat({ id: draft.id, projectId: "project-1" })],
      incomingChats: [persisted],
      incomingProjectChats: [persistedWire],
      projectId: "project-1"
    });

    expect(merged.chats).toHaveLength(1);
    expect(merged.chats[0]).toMatchObject({
      id: draft.id,
      messageCount: 2,
      pendingProjectDraft: undefined,
      title: "Persisted chat"
    });
    expect(merged.projectChats).toEqual([persistedWire]);
  });
});
