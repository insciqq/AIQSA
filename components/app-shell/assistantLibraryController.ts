import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import { useAssistantLibraryStore } from "@/components/app-shell/assistantLibraryStore";
import {
  createAssistantLibraryCore,
  editorDirty,
  sharingDirty,
  type AssistantLibraryControllerInput
} from "@/components/app-shell/assistantLibraryCore";
import {
  buildAssistantDeleteDialogView,
  buildAssistantDetailSheetView,
  buildAssistantGalleryView,
  createAssistantGalleryActions
} from "@/components/app-shell/assistantGalleryActions";
import {
  buildAssistantEditorView,
  buildAssistantNewAssistantView,
  createAssistantEditorActions
} from "@/components/app-shell/assistantEditorActions";
import {
  buildAssistantSharingSheetView,
  createAssistantSharingActions
} from "@/components/app-shell/assistantSharingActions";

export type { AssistantLibraryControllerInput } from "@/components/app-shell/assistantLibraryCore";

/**
 * The Assistant library facade the shell creates. Gallery, editor and Sharing
 * actions live in sibling files so their surfaces change independently.
 */
export function createAssistantLibraryActions(input: AssistantLibraryControllerInput) {
  const core = createAssistantLibraryCore(input);
  const gallery = createAssistantGalleryActions(core);
  const editor = createAssistantEditorActions(input, core);
  const sharing = createAssistantSharingActions(core);

  /** Leaves the editor and the Sharing sheet without saving. */
  function discardDrafts() {
    const snapshot = useAssistantLibraryStore.getState();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.sharing?.saving) return;
    snapshot.patch({
      editor: null,
      sharing: null,
      task: "list"
    });
  }

  return {
    ...gallery,
    ...editor,
    ...sharing,
    closeLibrary: core.closeLibrary,
    discardDrafts,
    ensureList: core.ensureList,
    openLibrary: core.openLibrary,
    refreshList: core.refreshList,
    useAssistant: core.useAssistant
  };
}

export type AssistantLibraryActions = ReturnType<typeof createAssistantLibraryActions>;

export function buildAssistantLibraryView(
  input: AssistantLibraryControllerInput,
  actions: AssistantLibraryActions,
  snapshot: ReturnType<typeof useAssistantLibraryStore.getState>
): AssistantLibraryView | null {
  if (!snapshot.open) return null;

  const catalog = input.catalog;
  const openEditor = (assistantId: string) => {
    void actions.openAssistantEditor(assistantId);
  };
  return {
    busy: snapshot.busy,
    catalogError: snapshot.dataState === "error" ? snapshot.dataError : input.catalogError,
    catalogState:
      snapshot.dataState === "error" || input.catalogError
        ? "error"
        : !catalog || snapshot.dataState === "loading"
          ? "loading"
          : "ready",
    deletion: buildAssistantDeleteDialogView(actions, snapshot),
    detail: buildAssistantDetailSheetView(input, snapshot),
    dirty: editorDirty(snapshot) || sharingDirty(snapshot),
    editor: buildAssistantEditorView(input, actions, {
      onOpenSharing: actions.openSharing,
      onUseInChat(assistantId) {
        void actions.useAssistant(assistantId, { navigate: true });
      }
    }, snapshot),
    gallery: buildAssistantGalleryView(actions, { onEdit: openEditor, onShare: actions.openSharing }, snapshot),
    newAssistant: buildAssistantNewAssistantView(actions, snapshot),
    notice: snapshot.notice,
    onBackToChat: actions.closeLibrary,
    onDiscardDrafts: actions.discardDrafts,
    onDismissNotice() {
      useAssistantLibraryStore.getState().patch({ notice: null });
    },
    onOpenMcpSettings: input.openMcpSettings,
    onRetryCatalog() {
      const current = useAssistantLibraryStore.getState();
      if (current.busy || current.editor?.saving) return;
      input.retryCatalog();
      void actions.refreshList();
    },
    sharing: buildAssistantSharingSheetView(input, actions, snapshot),
    task: snapshot.task
  };
}
