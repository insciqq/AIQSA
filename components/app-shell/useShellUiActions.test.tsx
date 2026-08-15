import { act, renderHook } from "@testing-library/react";
import { resetComposerSessionStoreForTest } from "@/tests/support/appShellStores";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerSessionKey,
  selectActiveComposerSession,
  useComposerSessionStore
} from "./composerSessionStore";
import { useShellUiActions } from "./useShellUiActions";

function renderActions(overrides: Partial<Parameters<typeof useShellUiActions>[0]> = {}) {
  return renderHook(() =>
    useShellUiActions({
      branchChatFromMessage: vi.fn(),
      copyMessage: vi.fn(),
      deleteMessage: vi.fn(),
      regenerateMessage: vi.fn(),
      ...overrides
    })
  );
}

describe("useShellUiActions", () => {
  afterEach(() => {
    resetComposerSessionStoreForTest();
  });

  it("snapshots an unsent draft before entering message edit mode", () => {
    const store = useComposerSessionStore.getState();
    store.activateSession(composerSessionKey("chat-a"));
    store.setDraft("Unsent draft");
    const { result } = renderActions();

    act(() =>
      result.current.handleEditMessage({
        content: "Saved question",
        id: "message-a",
        parentMessageId: null,
        role: "user",
        status: "complete"
      })
    );

    expect(selectActiveComposerSession(useComposerSessionStore.getState())).toMatchObject({
      draft: "Saved question",
      draftBeforeEdit: "Unsent draft",
      editingMessageId: "message-a"
    });
  });
});
