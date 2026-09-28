"use client";

/*
 * Editor slot of the Assistants tab: the full-page editor and the New
 * assistant sheet. "Manage sharing…" opens the tab's Sharing sheet.
 */
import type {
  AssistantEditorView,
  AssistantLibraryView
} from "@/components/assistants/libraryViewContracts";
import type { LibrarySubviewV2 } from "@/features/library-v2/contracts";
import type { AssistantsTabPropsV2 } from "./AssistantsTabV2";
import { AssistantEditorPageV2, assistantEditorTitle } from "./editor/AssistantEditorPageV2";
import { NewAssistantSheetV2 } from "./editor/NewAssistantSheetV2";

/**
 * The Studio crumb and Back control while the editor page is open. The key
 * stays the same across Create, so creating keeps focus where it is.
 */
export function assistantEditorSubviewV2(
  view: AssistantLibraryView,
  editor: AssistantEditorView,
  onBack: () => void
): LibrarySubviewV2 {
  return {
    backLabel: "Back to Assistants",
    busy: view.busy || editor.saving,
    key: "assistant-editor",
    label: assistantEditorTitle(editor),
    onBack
  };
}

export function AssistantEditorEntryV2({
  editor,
  onRequestClose,
  view
}: Omit<AssistantsTabPropsV2, "view"> & Readonly<{ editor: AssistantEditorView; view: AssistantLibraryView }>) {
  return (
    <AssistantEditorPageV2
      busy={view.busy}
      editor={editor}
      notice={view.notice}
      onDismissNotice={view.onDismissNotice}
      onOpenSharing={() => editor.onOpenSharing?.()}
      onRequestClose={onRequestClose}
    />
  );
}

/** The New assistant sheet (Blank, From current chat, templates). */
export function AssistantNewSheetEntryV2({ view }: AssistantsTabPropsV2) {
  return view ? <NewAssistantSheetV2 disabled={view.busy} view={view.newAssistant} /> : null;
}
