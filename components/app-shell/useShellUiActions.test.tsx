import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerSessionKey,
  resetComposerSessionStoreForTest,
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
      setInspectorActiveTab: vi.fn(),
      setInspectorMode: vi.fn(),
      ...overrides
    })
  );
}

describe("useShellUiActions", () => {
  afterEach(() => {
    resetComposerSessionStoreForTest();
  });

  it("opens the requested Details tab as an overlay", () => {
    const setInspectorActiveTab = vi.fn();
    const setInspectorMode = vi.fn();
    const { result } = renderActions({
      setInspectorActiveTab,
      setInspectorMode
    });

    act(() => result.current.openDetails("events"));

    expect(setInspectorActiveTab).toHaveBeenCalledWith("events");
    const modeUpdater = setInspectorMode.mock.calls[0]?.[0] as (mode: "closed") => string;
    expect(modeUpdater("closed")).toBe("overlay");
  });

  it("keeps pinned Details pinned while changing tabs", () => {
    const setInspectorMode = vi.fn();
    const { result } = renderActions({ setInspectorMode });

    act(() => result.current.openDetails("branch"));

    const modeUpdater = setInspectorMode.mock.calls[0]?.[0] as (mode: "pinned") => string;
    expect(modeUpdater("pinned")).toBe("pinned");
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
