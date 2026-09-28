import {
  deleteAssistant,
  duplicateAssistant,
  fetchAssistantDeletionConsequences,
  fetchAssistantDetail,
  setAssistantArchived,
  setAssistantPinned
} from "@/components/assistants/assistantsApi";
import type {
  AssistantDeleteDialogView,
  AssistantDetailSheetView,
  AssistantGalleryView
} from "@/components/assistants/libraryViewContracts";
import {
  nextAssistantSheetRequestId,
  useAssistantLibraryStore,
  type AssistantLibrarySnapshot
} from "@/components/app-shell/assistantLibraryStore";
import {
  assistantErrorText,
  type AssistantLibraryControllerInput,
  type AssistantLibraryCore
} from "@/components/app-shell/assistantLibraryCore";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";

const store = () => useAssistantLibraryStore.getState();

/**
 * How an archive or restore ended: refused because another library change
 * is in flight, overtaken by one, or failed with the library's copy.
 */
export type AssistantArchiveOutcome =
  | { ok: true }
  | { ok: false; reason: "busy" | "superseded" }
  | { ok: false; reason: "failed"; text: string };

function assistantName(snapshot: AssistantLibrarySnapshot, assistantId: string): string {
  return snapshot.data?.assistants.find((assistant) => assistant.id === assistantId)?.name ??
    (snapshot.detail?.assistantId === assistantId ? snapshot.detail.detail?.content.name : undefined) ??
    "this assistant";
}

/** Keeps an open detail sheet on the same Assistant in step with a mutation. */
function patchOpenDetail(assistantId: string, update: (detail: AssistantDetail) => AssistantDetail) {
  const sheet = store().detail;
  if (sheet?.assistantId !== assistantId || !sheet.detail) return;
  store().patch({ detail: { ...sheet, detail: update(sheet.detail) } });
}

async function loadDetail(assistantId: string) {
  const requestId = nextAssistantSheetRequestId();
  const previous = store().detail;
  store().patch({
    detail: {
      assistantId,
      detail: previous?.assistantId === assistantId ? previous.detail : null,
      error: null,
      requestId,
      state: "loading"
    }
  });
  const result = await fetchAssistantDetail(assistantId);
  const current = store().detail;
  if (current?.requestId !== requestId) return;
  if (result.ok) {
    store().patch({ detail: { ...current, detail: result.data, state: "ready" } });
  } else if (result.status === 400 || result.status === 404 || result.code === "assistant_not_available") {
    // Missing, invisible and malformed ids read the same.
    store().patch({ detail: { ...current, detail: null, state: "unavailable" } });
  } else {
    store().patch({ detail: { ...current, error: result.message, state: "error" } });
  }
}

/**
 * Opens the detail sheet. It needs no controller input, so a deep link can
 * call it right after Studio opens the Assistants section. A null id (a
 * malformed link) shows the same neutral notice as an unknown one, without
 * a request.
 */
export function openAssistantDetail(assistantId: string | null): void {
  if (assistantId === null) {
    store().patch({
      detail: { assistantId: "", detail: null, error: null, requestId: nextAssistantSheetRequestId(), state: "unavailable" }
    });
    return;
  }
  void loadDetail(assistantId);
}

/** Copies the Assistant's entry link (`/assistant/<id>`); false when the clipboard refused it. */
export async function copyAssistantLink(assistantId: string): Promise<boolean> {
  try {
    await writeClipboardText(new URL(formatAssistantEntryPath(assistantId), window.location.origin).toString());
    return true;
  } catch {
    return false;
  }
}

export function closeAssistantDetail(): void {
  store().patch({ detail: null });
}

async function loadConsequences(assistantId: string, error: string | null = null) {
  const requestId = nextAssistantSheetRequestId();
  const previous = store().deletion;
  store().patch({
    deletion: {
      assistantId,
      consequences: null,
      error,
      name: previous?.assistantId === assistantId ? previous.name : assistantName(store(), assistantId),
      requestId,
      state: "loading"
    }
  });
  const result = await fetchAssistantDeletionConsequences(assistantId);
  const current = store().deletion;
  if (current?.requestId !== requestId) return;
  store().patch({
    deletion: result.ok
      ? { ...current, consequences: result.data, state: "ready" }
      : { ...current, error: assistantErrorText(result.code, result.message), state: "error" }
  });
}

export function createAssistantGalleryActions(core: AssistantLibraryCore) {
  async function togglePinned(assistantId: string, pinned: boolean) {
    const requestId = core.beginBusyOperation();
    if (requestId === null) return;
    const result = await setAssistantPinned(assistantId, pinned);
    if (!core.ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      core.finishBusyOperation(requestId, {
        notice: { kind: "error", text: assistantErrorText(result.code, result.message) }
      });
      return;
    }
    const data = store().data;
    core.finishBusyOperation(requestId, data
      ? {
          data: {
            ...data,
            assistants: data.assistants.map((assistant) =>
              assistant.id === assistantId ? { ...assistant, pinned } : assistant
            )
          }
        }
      : {});
    patchOpenDetail(assistantId, (detail) => ({ ...detail, pinned }));
  }

  async function duplicateById(assistantId: string) {
    const requestId = core.beginBusyOperation();
    if (requestId === null) return;
    const result = await duplicateAssistant(assistantId);
    if (!core.ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      core.finishBusyOperation(requestId, { notice: { kind: "error", text: result.message } });
      return;
    }
    const { assistant, report } = result.data;
    const downgraded = report.downgradedRows.length > 0 || report.droppedSkillCount > 0;
    core.finishBusyOperation(requestId, {
      notice: {
        kind: "success",
        text: `Duplicated as ${assistant.content.name}. The copy is private.${downgraded
          ? " Setup you cannot use was reset to your own defaults."
          : ""}`
      }
    });
    void core.refreshList();
  }

  /**
   * Archives or restores at the current version. The library shows the
   * outcome in its own notice; the outcome also goes back to the caller, so
   * a restore started from a chat can report there.
   */
  async function toggleArchived(assistantId: string, archived: boolean): Promise<AssistantArchiveOutcome> {
    const requestId = core.beginBusyOperation();
    if (requestId === null) return { ok: false, reason: "busy" };
    const fail = (text: string): AssistantArchiveOutcome => {
      core.finishBusyOperation(requestId, { notice: { kind: "error", text } });
      return { ok: false, reason: "failed", text };
    };
    const detail = await fetchAssistantDetail(assistantId);
    if (!core.ownsBusyOperation(requestId)) return { ok: false, reason: "superseded" };
    if (!detail.ok || detail.data.version === undefined) {
      return fail(detail.ok ? "Only the owner can archive this assistant." : detail.message);
    }
    const result = await setAssistantArchived(assistantId, detail.data.version, archived);
    if (!core.ownsBusyOperation(requestId)) return { ok: false, reason: "superseded" };
    if (!result.ok) return fail(assistantErrorText(result.code, result.message));
    const name = result.data.content.name;
    core.finishBusyOperation(requestId, {
      notice: {
        kind: "success",
        text: archived
          ? `Archived ${name}. People it is shared with can't start new chats with it; past chats keep their answers. Restore it any time.`
          : `Restored ${name}.`
      }
    });
    patchOpenDetail(assistantId, () => result.data);
    void core.refreshList();
    return { ok: true };
  }

  function openDelete(assistantId: string) {
    if (store().deletion?.state === "deleting") return;
    void loadConsequences(assistantId);
  }

  function closeDelete() {
    if (store().deletion?.state === "deleting") return;
    store().patch({ deletion: null });
  }

  function retryDelete() {
    const deletion = store().deletion;
    if (deletion && deletion.state !== "deleting") void loadConsequences(deletion.assistantId);
  }

  /**
   * Deletes at the version the owner confirmed. Publications and Project
   * bindings do not bump the version, so a conflict reloads the consequences
   * and asks again instead of deleting against stale ones.
   */
  async function confirmDelete() {
    const deletion = store().deletion;
    if (!deletion || deletion.state !== "ready" || !deletion.consequences) return;
    const requestId = nextAssistantSheetRequestId();
    store().patch({ deletion: { ...deletion, error: null, requestId, state: "deleting" } });
    const result = await deleteAssistant(deletion.assistantId, deletion.consequences.version);
    const current = store().deletion;
    if (current?.requestId !== requestId) return;
    if (result.ok) {
      const snapshot = store();
      const editing = snapshot.editor?.assistantId === deletion.assistantId;
      snapshot.patch({
        data: snapshot.data
          ? {
              ...snapshot.data,
              assistants: snapshot.data.assistants.filter((assistant) => assistant.id !== deletion.assistantId),
              recentAssistantIds: snapshot.data.recentAssistantIds.filter((id) => id !== deletion.assistantId),
              viewer: {
                ...snapshot.data.viewer,
                defaultAssistantId: snapshot.data.viewer.defaultAssistantId === deletion.assistantId
                  ? null
                  : snapshot.data.viewer.defaultAssistantId
              }
            }
          : null,
        deletion: null,
        ...(snapshot.detail?.assistantId === deletion.assistantId ? { detail: null } : {}),
        ...(snapshot.sharing?.assistantId === deletion.assistantId ? { sharing: null } : {}),
        ...(editing ? { editor: null, task: "list" as const } : {}),
        notice: { kind: "success", text: `Deleted ${deletion.name}.` }
      });
      void core.refreshList();
      return;
    }
    if (result.code === "assistant_version_conflict") {
      void loadConsequences(
        deletion.assistantId,
        "This assistant changed. Review what deleting it changes, then confirm again."
      );
      return;
    }
    store().patch({
      deletion: { ...current, error: assistantErrorText(result.code, result.message), state: "error" }
    });
    if (result.code === "assistant_not_available") void core.refreshList();
  }

  function startChat(assistantId: string): Promise<boolean> {
    return core.useAssistant(assistantId, { navigate: true });
  }

  return {
    closeDelete,
    closeDetail: closeAssistantDetail,
    confirmDelete,
    duplicateById,
    openDelete,
    openDetail: openAssistantDetail,
    retryDelete,
    startChat,
    toggleArchived,
    togglePinned
  };
}

export type AssistantGalleryActions = ReturnType<typeof createAssistantGalleryActions>;

export function buildAssistantGalleryView(
  actions: AssistantGalleryActions,
  handlers: { onEdit(assistantId: string): void; onShare(assistantId: string): void },
  snapshot: AssistantLibrarySnapshot
): AssistantGalleryView {
  return {
    assistants: snapshot.data?.assistants ?? [],
    onArchiveToggle(assistantId, archived) {
      void actions.toggleArchived(assistantId, archived);
    },
    onCopyLink: copyAssistantLink,
    onDelete: actions.openDelete,
    onDuplicate(assistantId) {
      void actions.duplicateById(assistantId);
    },
    onEdit: handlers.onEdit,
    onOpenDetail: actions.openDetail,
    onPinToggle(assistantId, pinned) {
      void actions.togglePinned(assistantId, pinned);
    },
    onShare: handlers.onShare,
    onStartChat: actions.startChat,
    recentAssistantIds: snapshot.data?.recentAssistantIds ?? [],
    viewer: {
      canPublishInstallation: snapshot.data?.viewer.canPublishInstallation ?? false,
      defaultAssistantId: snapshot.data?.viewer.defaultAssistantId ?? null
    }
  };
}

export function buildAssistantDetailSheetView(
  input: Pick<AssistantLibraryControllerInput, "catalog" | "knowledgeBases" | "knowledgeSources">,
  snapshot: AssistantLibrarySnapshot
): AssistantDetailSheetView | null {
  const sheet = snapshot.detail;
  if (!sheet) return null;
  return {
    assistantId: sheet.assistantId,
    detail: sheet.detail,
    error: sheet.error,
    // The viewer's own catalogs: a row id outside them stays unnamed.
    names: {
      knowledgeBases: input.knowledgeBases,
      knowledgeSources: input.knowledgeSources,
      mcpServers: snapshot.mcpOptions,
      models: (input.catalog?.models ?? []).map((model) => ({ id: model.modelId, label: model.displayName })),
      searchOptions: (input.catalog?.searchStrategies ?? [])
        .filter((strategy) => strategy.kind !== "none")
        .map((strategy) => ({ id: strategy.strategyId, label: strategy.displayName }))
    },
    onClose: closeAssistantDetail,
    onRetry() {
      openAssistantDetail(sheet.assistantId);
    },
    state: sheet.state,
    summary: snapshot.data?.assistants.find((assistant) => assistant.id === sheet.assistantId) ?? null
  };
}

export function buildAssistantDeleteDialogView(
  actions: AssistantGalleryActions,
  snapshot: AssistantLibrarySnapshot
): AssistantDeleteDialogView | null {
  const deletion = snapshot.deletion;
  if (!deletion) return null;
  return {
    assistantId: deletion.assistantId,
    consequences: deletion.consequences,
    error: deletion.error,
    name: deletion.name,
    onCancel: actions.closeDelete,
    onConfirm() {
      void actions.confirmDelete();
    },
    onRetry: actions.retryDelete,
    state: deletion.state
  };
}
