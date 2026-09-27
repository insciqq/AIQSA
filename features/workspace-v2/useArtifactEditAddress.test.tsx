import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { loadArtifactDetail, prepareArtifactEdit } from "@/components/artifacts/artifactClient";
import { useArtifactPanelStore } from "@/components/artifacts/artifactPanelStore";
import { storeArtifactRuntimeError } from "@/components/artifacts/artifactRuntimeSession";
import type { ArtifactDetail } from "@/lib/contracts/artifacts";
import { resetComposerSessionStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { useArtifactEditAddress } from "./useArtifactEditAddress";

vi.mock("@/components/artifacts/artifactClient", () => ({
  loadArtifactDetail: vi.fn(),
  prepareArtifactEdit: vi.fn()
}));

const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
const detail: ArtifactDetail = {
  currentVersionId: "version-2",
  id: "artifact-1",
  publications: [],
  sourceChatId: "chat-1",
  title: "Reliability notebook",
  versions: [
    { entrypoint: "index.html", id: "version-2", kind: "html", title: "Reliability notebook", versionNumber: 2 },
    { entrypoint: "index.html", id: "version-1", kind: "html", title: "Reliability notebook", versionNumber: 1 }
  ]
};

type HookInput = Parameters<typeof useArtifactEditAddress>[0];

/** The shell mounts on the handed-off address, then its bootstrap shows and loads the chat. */
function mountShell(panelFits = false) {
  const initialProps: HookInput = { activeChatId: null, detailLoading: false, panelFits: () => panelFits };
  return renderHook((input: HookInput) => useArtifactEditAddress(input), { initialProps });
}

function showChat(chatId: string) {
  useWorkspaceStore.setState({ activeChatId: chatId });
  useComposerSessionStore.getState().activateSession(composerSessionKey(chatId));
}

beforeEach(() => {
  vi.mocked(prepareArtifactEdit).mockResolvedValue("chat-1");
  vi.mocked(loadArtifactDetail).mockResolvedValue(detail);
});

afterEach(() => {
  cleanup();
  resetComposerSessionStoreForTest();
  resetWorkspaceStoreForTest();
  useArtifactPanelStore.setState({ open: null });
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("artifact edits handed to a chat through its address", () => {
  it("fills the composer of the addressed chat once a real navigation has shown and loaded it", async () => {
    storeArtifactRuntimeError("version-1", { column: 470, kind: "error", line: 94, message: "Uncaught Error: notebookCounter is not defined" });
    window.history.replaceState(null, "", "/c/chat-1?artifactEdit=runtime_error&artifactId=artifact-1&versionId=version-1&library=mcp");
    const shell = mountShell();
    expect(prepareArtifactEdit).not.toHaveBeenCalled();

    showChat("chat-1");
    shell.rerender({ activeChatId: "chat-1", detailLoading: true, panelFits: () => false });
    expect(prepareArtifactEdit).not.toHaveBeenCalled();
    shell.rerender({ activeChatId: "chat-1", detailLoading: false, panelFits: () => false });

    await waitFor(() => expect(address()).toBe("/c/chat-1?library=mcp"));
    expect(prepareArtifactEdit).toHaveBeenCalledExactlyOnceWith("artifact-1", "version-1", "chat-1");
    expect(loadArtifactDetail).toHaveBeenCalledWith("artifact-1", expect.any(AbortSignal), "version-1");
    const session = selectComposerSession(useComposerSessionStore.getState(), composerSessionKey("chat-1"));
    expect(session.artifactEdit).toEqual({ artifactId: "artifact-1", title: "Reliability notebook", versionId: "version-1", versionNumber: 1 });
    expect(session.draft).toMatch(/Fix the runtime error.*notebookCounter is not defined/u);
    expect(sessionStorage.length).toBe(0);
    expect(useArtifactPanelStore.getState().open).toBeNull();

    shell.rerender({ activeChatId: "chat-1", detailLoading: false, panelFits: () => false });
    expect(prepareArtifactEdit).toHaveBeenCalledOnce();
  });

  it("follows a Project chat address and docks the artifact when it fits", async () => {
    window.history.replaceState(null, "", "/p/project-1/c/chat-1?artifactEdit=edit&artifactId=artifact-1&versionId=version-2");
    const shell = mountShell(true);
    showChat("chat-1");
    shell.rerender({ activeChatId: "chat-1", detailLoading: false, panelFits: () => true });

    await waitFor(() => expect(address()).toBe("/p/project-1/c/chat-1"));
    expect(useArtifactPanelStore.getState().open).toEqual({ artifactId: "artifact-1", chatId: "chat-1", versionId: "version-2" });
    expect(selectComposerSession(useComposerSessionStore.getState(), composerSessionKey("chat-1")).draft).toBe("");
  });

  it("waits for the addressed chat and leaves another shown chat untouched", async () => {
    window.history.replaceState(null, "", "/c/chat-1?artifactEdit=edit&artifactId=artifact-1&versionId=version-2");
    const shell = mountShell();
    showChat("chat-2");
    shell.rerender({ activeChatId: "chat-2", detailLoading: false, panelFits: () => false });
    await act(async () => undefined);
    expect(prepareArtifactEdit).not.toHaveBeenCalled();
    expect(address()).toBe("/c/chat-1?artifactEdit=edit&artifactId=artifact-1&versionId=version-2");
  });

  it("reports a version that is gone in the addressed chat's composer", async () => {
    window.history.replaceState(null, "", "/c/chat-1?artifactEdit=edit&artifactId=artifact-1&versionId=version-9");
    const shell = mountShell();
    showChat("chat-1");
    shell.rerender({ activeChatId: "chat-1", detailLoading: false, panelFits: () => false });
    await waitFor(() => expect(
      selectComposerSession(useComposerSessionStore.getState(), composerSessionKey("chat-1")).operationError
    ).toBe("This artifact is no longer available."));
    expect(address()).toBe("/c/chat-1?artifactEdit=edit&artifactId=artifact-1&versionId=version-9");
  });
});
