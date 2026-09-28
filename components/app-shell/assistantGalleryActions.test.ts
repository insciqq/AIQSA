import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantControllerInput,
  assistantDetail,
  assistantList,
  assistantSummary,
  deferred,
  installAssistantEditor
} from "@/tests/support/assistantLibraryFixtures";
import { useAssistantLibraryStore } from "./assistantLibraryStore";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions
} from "./assistantLibraryController";
import { copyAssistantLink, openAssistantDetail } from "./assistantGalleryActions";

const mocks = vi.hoisted(() => ({
  deleteAssistant: vi.fn(),
  duplicateAssistant: vi.fn(),
  fetchAssistantDeletionConsequences: vi.fn(),
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  loadUserMcpServers: vi.fn(),
  setAssistantArchived: vi.fn(),
  setAssistantPinned: vi.fn(),
  writeClipboardText: vi.fn()
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  deleteAssistant: mocks.deleteAssistant,
  duplicateAssistant: mocks.duplicateAssistant,
  fetchAssistantDeletionConsequences: mocks.fetchAssistantDeletionConsequences,
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  setAssistantArchived: mocks.setAssistantArchived,
  setAssistantPinned: mocks.setAssistantPinned
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

vi.mock("@/components/clipboard/writeClipboardText", () => ({
  writeClipboardText: mocks.writeClipboardText
}));

const store = () => useAssistantLibraryStore.getState();

function consequences(version: number): AssistantDeletionConsequences {
  return {
    audiences: { groupNames: ["Platform"], installation: false },
    chatCount: 4,
    hiddenProjectCount: 0,
    pendingListingRequest: false,
    projects: [{ isDefault: true, name: "Support" }],
    version
  };
}

function view(input = assistantControllerInput(), actions = createAssistantLibraryActions(input)) {
  return buildAssistantLibraryView(input, actions, store())!;
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({ data: assistantList(), ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
  store().patch({
    data: assistantList({
      assistants: [assistantSummary(), assistantSummary({ id: "assistant-2", name: "Writer" })],
      recentAssistantIds: ["assistant-1"],
      viewer: { canPublishInstallation: false, defaultAssistantId: "assistant-1" }
    }),
    dataState: "ready",
    open: true
  });
});

describe("Assistant gallery", () => {
  it("exposes the list with recents and the viewer's default", () => {
    expect(view().gallery).toMatchObject({
      assistants: [expect.objectContaining({ id: "assistant-1" }), expect.objectContaining({ id: "assistant-2" })],
      recentAssistantIds: ["assistant-1"],
      viewer: { canPublishInstallation: false, defaultAssistantId: "assistant-1" }
    });
  });

  it("opens the detail sheet from the list entry and keeps only the latest request", async () => {
    const first = deferred<{ data: ReturnType<typeof assistantDetail>; ok: true }>();
    mocks.fetchAssistantDetail
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: assistantDetail(3, { id: "assistant-2" }), ok: true });

    view().gallery.onOpenDetail("assistant-1");
    expect(view().detail).toMatchObject({ assistantId: "assistant-1", state: "loading", summary: { id: "assistant-1" } });
    view().gallery.onOpenDetail("assistant-2");
    first.resolve({ data: assistantDetail(), ok: true });
    await vi.waitFor(() => expect(view().detail?.state).toBe("ready"));

    expect(view().detail).toMatchObject({ assistantId: "assistant-2", detail: { id: "assistant-2" } });
    view().detail!.onClose();
    expect(store().detail).toBeNull();
  });

  it("shows a neutral unavailable state for a deep link to a missing Assistant", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({
      code: "assistant_not_available", message: "Not found.", ok: false, status: 404
    });

    openAssistantDetail("hidden");

    await vi.waitFor(() => expect(store().detail).toMatchObject({
      assistantId: "hidden",
      detail: null,
      state: "unavailable"
    }));
  });

  it("treats a malformed id like an unknown one, without a request", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({ code: "assistant_draft_invalid", message: "Bad id.", ok: false, status: 400 });

    openAssistantDetail(null);
    expect(store().detail).toMatchObject({ detail: null, state: "unavailable" });
    expect(mocks.fetchAssistantDetail).not.toHaveBeenCalled();

    openAssistantDetail("x".repeat(40));
    await vi.waitFor(() => expect(store().detail).toMatchObject({ error: null, state: "unavailable" }));
  });

  it("names Setup resources only from the viewer's own catalogs", () => {
    const input = { ...assistantControllerInput(), knowledgeBases: [{ available: true, id: "base-1", name: "Handbook" }] };
    store().patch({
      detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" },
      mcpOptions: [{ enabled: true, id: "mcp-1", name: "Jira", readiness: "ready" }]
    });

    expect(view(input).detail?.names).toEqual({
      knowledgeBases: [{ available: true, id: "base-1", name: "Handbook" }],
      knowledgeSources: [],
      mcpServers: [{ enabled: true, id: "mcp-1", name: "Jira", readiness: "ready" }],
      models: [{ id: "model-1", label: "Model one" }],
      searchOptions: []
    });
  });

  it("copies the Assistant's entry link and reports a refused clipboard", async () => {
    mocks.writeClipboardText.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("copy_failed"));

    await expect(copyAssistantLink("assistant 1")).resolves.toBe(true);
    expect(mocks.writeClipboardText).toHaveBeenCalledWith(`${window.location.origin}/assistant/assistant%201`);
    await expect(view().gallery.onCopyLink("assistant-1")).resolves.toBe(false);
  });

  it("keeps an open detail sheet in step with pin changes", async () => {
    mocks.setAssistantPinned.mockResolvedValue({ data: undefined, ok: true });
    store().patch({
      detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" }
    });

    view().gallery.onPinToggle("assistant-1", true);

    await vi.waitFor(() => expect(store().detail?.detail?.pinned).toBe(true));
    expect(store().data?.assistants[0]?.pinned).toBe(true);
  });

  it("reports what a duplicate could not keep", async () => {
    mocks.duplicateAssistant.mockResolvedValue({
      data: { assistant: assistantDetail(1, { id: "copy" }), report: { downgradedRows: ["tools"], droppedSkillCount: 0 } },
      ok: true
    });

    view().gallery.onDuplicate("assistant-1");

    await vi.waitFor(() => expect(store().notice).toEqual({
      kind: "success",
      text: "Duplicated as Code reviewer. The copy is private. Setup you cannot use was reset to your own defaults."
    }));
  });

  it("marks archive busy before its detail preflight settles", async () => {
    const preflight = deferred<{ data: ReturnType<typeof assistantDetail>; ok: true }>();
    mocks.fetchAssistantDetail.mockReturnValue(preflight.promise);
    mocks.setAssistantArchived.mockResolvedValue({ data: assistantDetail(4), ok: true });
    const actions = createAssistantLibraryActions(assistantControllerInput());

    const pending = actions.toggleArchived("assistant-1", true);
    expect(store().busy).toBe(true);
    preflight.resolve({ data: assistantDetail(3), ok: true });
    await pending;

    expect(store().busy).toBe(false);
  });

  it("returns the outcome of a restore along with the library's own notice", async () => {
    const actions = createAssistantLibraryActions(assistantControllerInput());
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(3), ok: true });
    mocks.setAssistantArchived.mockResolvedValue({ data: assistantDetail(4), ok: true });

    await expect(actions.toggleArchived("assistant-1", false)).resolves.toEqual({ ok: true });
    expect(mocks.setAssistantArchived).toHaveBeenCalledWith("assistant-1", 3, false);
    expect(store()).toMatchObject({ busy: false, notice: { kind: "success", text: "Restored Code reviewer." } });
  });

  it("returns the library's failure copy when the detail read or the archive call fails", async () => {
    const actions = createAssistantLibraryActions(assistantControllerInput());
    const failures: [string, unknown, unknown][] = [
      [
        "The assistant request could not reach the server.",
        { code: "network_unavailable", message: "The assistant request could not reach the server.", ok: false },
        undefined
      ],
      [
        "Only the owner can archive this assistant.",
        // Only the owner reads the version.
        { data: assistantDetail(3, { version: undefined }), ok: true },
        undefined
      ],
      [
        "This assistant changed in another session. Reload Assistants and reapply your edit.",
        { data: assistantDetail(3), ok: true },
        { code: "assistant_version_conflict", message: "Conflict.", ok: false, status: 409 }
      ],
      [
        "The assistant request could not be completed.",
        { data: assistantDetail(3), ok: true },
        { code: "assistant_request_failed", message: "The assistant request could not be completed.", ok: false, status: 500 }
      ]
    ];
    for (const [text, read, archive] of failures) {
      mocks.fetchAssistantDetail.mockResolvedValueOnce(read);
      if (archive) mocks.setAssistantArchived.mockResolvedValueOnce(archive);

      await expect(actions.toggleArchived("assistant-1", false)).resolves.toEqual({ ok: false, reason: "failed", text });
      expect(store()).toMatchObject({ busy: false, notice: { kind: "error", text } });
    }
    expect(mocks.setAssistantArchived).toHaveBeenCalledTimes(2);
  });

  it("refuses a restore while another library change is in flight, without a request", async () => {
    const actions = createAssistantLibraryActions(assistantControllerInput());
    store().patch({ busy: true, busyRequestId: 5 });

    await expect(actions.toggleArchived("assistant-1", false)).resolves.toEqual({ ok: false, reason: "busy" });
    expect(mocks.fetchAssistantDetail).not.toHaveBeenCalled();
    expect(store()).toMatchObject({ busy: true, notice: null });
  });
});

describe("Assistant deletion", () => {
  it("lists the consequences, deletes at their version and drops every reference", async () => {
    mocks.fetchAssistantDeletionConsequences.mockResolvedValue({ data: consequences(7), ok: true });
    mocks.deleteAssistant.mockResolvedValue({ data: undefined, ok: true });
    // The follow-up list refresh stays pending so the local removal is observable.
    mocks.fetchAssistantList.mockReturnValue(new Promise(() => undefined));
    store().patch({
      detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" }
    });

    view().gallery.onDelete("assistant-1");
    expect(view().deletion).toMatchObject({ name: "Code reviewer", state: "loading" });
    await vi.waitFor(() => expect(view().deletion?.state).toBe("ready"));
    expect(view().deletion?.consequences?.projects).toEqual([{ isDefault: true, name: "Support" }]);

    view().deletion!.onConfirm();

    await vi.waitFor(() => expect(store().deletion).toBeNull());
    expect(mocks.deleteAssistant).toHaveBeenCalledWith("assistant-1", 7);
    expect(store()).toMatchObject({ detail: null, notice: { kind: "success", text: "Deleted Code reviewer." } });
    expect(store().data).toMatchObject({
      assistants: [expect.objectContaining({ id: "assistant-2" })],
      recentAssistantIds: [],
      viewer: { defaultAssistantId: null }
    });
  });

  it("reloads the consequences when the Assistant changed before confirmation", async () => {
    mocks.fetchAssistantDeletionConsequences
      .mockResolvedValueOnce({ data: consequences(7), ok: true })
      .mockResolvedValueOnce({ data: { ...consequences(8), chatCount: 5 }, ok: true });
    mocks.deleteAssistant.mockResolvedValue({ code: "assistant_version_conflict", message: "Conflict.", ok: false, status: 409 });

    view().gallery.onDelete("assistant-1");
    await vi.waitFor(() => expect(view().deletion?.state).toBe("ready"));
    view().deletion!.onConfirm();

    await vi.waitFor(() => expect(view().deletion?.consequences?.version).toBe(8));
    expect(view().deletion).toMatchObject({
      error: "This assistant changed. Review what deleting it changes, then confirm again.",
      state: "ready"
    });
    expect(store().data?.assistants).toHaveLength(2);
  });

  it("closes the editor of an Assistant deleted from its detail sheet", async () => {
    installAssistantEditor();
    store().patch({ data: assistantList({ assistants: [assistantSummary()] }) });
    mocks.fetchAssistantDeletionConsequences.mockResolvedValue({ data: consequences(3), ok: true });
    mocks.deleteAssistant.mockResolvedValue({ data: undefined, ok: true });

    view().gallery.onDelete("assistant-1");
    await vi.waitFor(() => expect(view().deletion?.state).toBe("ready"));
    view().deletion!.onConfirm();

    await vi.waitFor(() => expect(store().editor).toBeNull());
    expect(store().task).toBe("list");
  });
});
