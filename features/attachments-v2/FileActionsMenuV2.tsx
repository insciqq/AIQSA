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
