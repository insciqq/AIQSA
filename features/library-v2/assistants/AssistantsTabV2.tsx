"use client";

import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import type { LibrarySubviewV2 } from "@/features/library-v2/contracts";
import {
  AssistantEditorEntryV2,
  AssistantNewSheetEntryV2,
  assistantEditorSubviewV2
} from "./AssistantEditorEntryV2";
import {
  AssistantDeleteDialogEntryV2,
  AssistantDetailSheetEntryV2,
  AssistantGalleryEntryV2
} from "./AssistantGalleryEntryV2";
import { AssistantSharingSheetV2 } from "./sharing/AssistantSharingSheetV2";

export type AssistantsTabPropsV2 = Readonly<{
  /** The chat composer: starters, temporary chats. */
  composer: ShellComposerView;
  onOpenMcpSettings(): void;
  /** Leaves the editor page through the Studio unsaved-changes guard. */
  onRequestClose(): void;
  /** Null until Studio has opened the Assistants section. */
  view: AssistantLibraryView | null;
}>;

/**
 * Studio › Assistants. The one entry the Studio shell renders for the tab:
 * the gallery or the editor page, and the sheets over them. Each surface
 * lives in its own slot file so the gallery and the editor change
 * independently.
 */
export function AssistantsTabV2(props: AssistantsTabPropsV2) {
  const { view } = props;
  const editor = view?.task === "editor" ? view.editor : null;
  return (
    <>
      {view && editor ? (
        <AssistantEditorEntryV2 {...props} editor={editor} view={view} />
      ) : (
        <AssistantGalleryEntryV2 {...props} />
      )}
      <AssistantNewSheetEntryV2 {...props} />
      {view && !editor ? <AssistantDetailSheetEntryV2 composer={props.composer} view={view} /> : null}
      {view ? <AssistantDeleteDialogEntryV2 view={view} /> : null}
      {/* After the detail sheet: over it, it is the top layer and returns to it. */}
      {view?.sharing ? <AssistantSharingSheetV2 key={view.sharing.assistantId} view={view.sharing} /> : null}
    </>
  );
}

/** The Studio crumb for the tab's current subview, or null on the gallery. */
export function assistantsTabSubviewV2(
  view: AssistantLibraryView | null,
  onBack: () => void
): LibrarySubviewV2 | null {
  return view?.task === "editor" && view.editor ? assistantEditorSubviewV2(view, view.editor, onBack) : null;
}
