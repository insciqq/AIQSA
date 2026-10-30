"use client";

import { useState } from "react";
import { saveFileToLibrary, useFileLibraryStore } from "@/components/app-shell/fileLibraryStore";
import { UiV2Icon, UiV2IconButton, UiV2MenuItem } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";

/**
 * A file's secondary verbs behind "⋯": Download stays the visible action and
 * saving a copy to Files is one menu item away. A short status beside the
 * trigger confirms the save, or its failure, after the menu has closed.
 */
export function FileActionsMenuV2({ attachmentId, fileName }: Readonly<{
  attachmentId: string;
  fileName: string;
}>) {
  const state = useFileLibraryStore((current) => current.mutations[attachmentId]);
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef, closeForAction } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  const saved = state === "saved";
  return (
    <span className="v2-file-actions-menu">
      {state === "saving" ? <small role="status">Saving…</small> : null}
      {saved ? <small role="status"><UiV2Icon name="check" />Saved</small> : null}
      {state === "error" ? <small role="alert">Could not save</small> : null}
      <UiV2IconButton
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        icon="more"
        label={`More actions for ${fileName}`}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} label={`Actions for ${fileName}`} menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuItem
            disabled={state === "saving" || saved}
            icon="folder-plus"
            onClick={() => { closeForAction(); void saveFileToLibrary(attachmentId); }}
          >
            {saved ? "Saved to Files" : "Save to Files"}
          </UiV2MenuItem>
        </UiV2ResponsiveMenu>
      ) : null}
    </span>
  );
}

/** Save to Files as a plain button, for the image viewer where a nested menu has no place. */
export function SaveToFilesButtonV2({ attachmentId, iconOnly = false }: Readonly<{ attachmentId: string; iconOnly?: boolean }>) {
  const state = useFileLibraryStore((current) => current.mutations[attachmentId]);
  const saved = state === "saved";
  const saving = state === "saving";
  return (
    <span className="v2-file-actions-menu">
      {saving ? <small role="status">Saving…</small> : null}
      {saved ? <small className="v2-sr-only" role="status">Saved</small> : null}
      {state === "error" ? <small role="alert">Could not save</small> : null}
      {/* Not `disabled`: that would drop the viewer's focus to the page the moment the save lands. */}
      {iconOnly ? <UiV2IconButton aria-busy={saving || undefined} aria-disabled={saving || saved || undefined}
        icon={saved ? "check" : "folder-plus"} label={saved ? "Saved to Files" : "Save to Files"}
        onClick={() => { if (!saving && !saved) void saveFileToLibrary(attachmentId); }} /> : <button aria-busy={saving || undefined} aria-disabled={saving || saved || undefined} className="v2-focusable v2-save-to-files"
        onClick={() => { if (!saving && !saved) void saveFileToLibrary(attachmentId); }} type="button">
        <UiV2Icon name={saved ? "check" : "folder-plus"} />
        {saved ? "Saved to Files" : "Save to Files"}
      </button>}
    </span>
  );
}
