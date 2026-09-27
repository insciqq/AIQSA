import { afterEach, describe, expect, it } from "vitest";
import {
  resetComposerSessionStoreForTest, resetRunSurfaceStoreForTest,
  resetThreadStoreForTest, resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { composerSessionKey, useComposerSessionStore } from "./composerSessionStore";
import { removePermanentlyDeletedChat } from "./permanentChatDeletionReconciliation";
import { useRunSurfaceStore } from "./runSurfaceStore";
import { useThreadStore } from "./threadStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { WorkspaceChatSummary } from "./types";

function chat(id: string, input: Partial<WorkspaceChatSummary> = {}): WorkspaceChatSummary {
  return {
    id, title: id, activeLeafMessageId: null, defaultProvider: "fake", defaultModelId: "fake-qsa",
    folderId: null, messageCount: 0, createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    ...input
  };
}

describe("permanent chat deletion reconciliation", () => {
  afterEach(() => {
    resetWorkspaceStoreForTest();
    resetThreadStoreForTest();
    resetRunSurfaceStoreForTest();
    resetComposerSessionStoreForTest();
  });

  it.each([true, false])("removes both navigation projections with search active (deleted chat active: %s)", (active) => {
    const deleted = chat("delete");
    const kept = chat("keep");
    const navigation = [deleted, kept].map((entry) => ({ ...entry, activeRun: false, pinned: false }));
    useWorkspaceStore.setState({ chats: [deleted, kept], activeChatId: active ? deleted.id : kept.id,
      navigationChats: navigation, navigationSearchChats: navigation, navigationSearchQuery: "example" });
    useThreadStore.getState().replaceThread(deleted.id, { activeLeafId: null, messages: [], usageStats: null });
    useRunSurfaceStore.getState().resetSurface(deleted.id);
    useComposerSessionStore.getState().activateSession(composerSessionKey(deleted.id));
    useComposerSessionStore.getState().setDraft("Unsent text");

    expect(removePermanentlyDeletedChat(deleted.id)).toEqual({ wasActive: active, nextChat: kept, scopeProjectId: null });
    const workspace = useWorkspaceStore.getState();
    expect(workspace.chats.map((entry) => entry.id)).toEqual([kept.id]);
    expect(workspace.navigationChats.map((entry) => entry.id)).toEqual([kept.id]);
    expect(workspace.navigationSearchChats.map((entry) => entry.id)).toEqual([kept.id]);
    expect(workspace.navigationSearchQuery).toBe("example");
    expect(useThreadStore.getState().threadsByChatId[deleted.id]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId[deleted.id]).toBeUndefined();
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey(deleted.id)]).toBeUndefined();
  });

  it("selects the blank workspace fallback after deleting the final active chat", () => {
    const deleted = chat("delete");
    useWorkspaceStore.setState({ chats: [deleted], activeChatId: deleted.id });
    expect(removePermanentlyDeletedChat(deleted.id)).toEqual({ wasActive: true, nextChat: null, scopeProjectId: null });
    expect(useWorkspaceStore.getState().chats).toEqual([]);
  });

  it("replaces a deleted chat only from its own scope, keeping every other scope's drafts", () => {
    // Newest first, as the store sorts them: Project rows lead a mixed list.
    const reservation = chat("project-reservation", { projectId: "project-1",
      pendingProjectDraft: { folderId: null, projectId: "project-1" }, updatedAt: "2026-09-15T00:00:03.000Z" });
    const saved = chat("project-saved", { projectId: "project-1", updatedAt: "2026-09-15T00:00:02.000Z" });
    const otherProject = chat("other-project", { projectId: "project-2", updatedAt: "2026-09-15T00:00:01.000Z" });
    const personal = chat("personal-kept");
    const deleted = chat("personal-deleted");
    useWorkspaceStore.setState({ chats: [reservation, saved, otherProject, personal, deleted], activeChatId: deleted.id });
    useComposerSessionStore.getState().activateSession(composerSessionKey(saved.id));
    useComposerSessionStore.getState().setDraft("Project draft");
    expect(removePermanentlyDeletedChat(deleted.id)).toEqual({ wasActive: true, nextChat: personal, scopeProjectId: null });
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey(saved.id)]?.draft).toBe("Project draft");

    useWorkspaceStore.setState({ activeChatId: personal.id });
    expect(removePermanentlyDeletedChat(personal.id)).toEqual({ wasActive: true, nextChat: null, scopeProjectId: null });
    useWorkspaceStore.setState({ activeChatId: saved.id });
    expect(removePermanentlyDeletedChat(saved.id)).toEqual({ wasActive: true, nextChat: reservation, scopeProjectId: "project-1" });
    expect(useWorkspaceStore.getState().chats.map((entry) => entry.id)).toEqual([reservation.id, otherProject.id]);
  });
});
