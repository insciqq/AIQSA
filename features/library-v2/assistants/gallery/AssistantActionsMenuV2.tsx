"use client";

import type { AssistantGalleryView } from "@/components/assistants/libraryViewContracts";
import { UiV2IconButton, UiV2MenuItem, UiV2MenuSeparator } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState } from "react";

export type AssistantMenuTarget = Readonly<{
  archived: boolean;
  id: string;
  name: string;
  owned: boolean;
}>;

/**
 * The "…" menu of a card and of the detail sheet: Edit (owner, card only),
 * Duplicate, Copy link, Share… (owner), Archive or Restore (owner) and
 * Delete (owner). No Export yet (an optional stage). Focus returns to the trigger before an
 * action runs, so a dialog it opens restores focus there, on phones too.
 */
export function AssistantActionsMenuV2({
  assistant,
  canDuplicate,
  disabled,
  gallery,
  includeEdit,
  onCopied
}: Readonly<{
  assistant: AssistantMenuTarget;
  /** Only listed Assistants can be copied; a Project member's detail read cannot. */
  canDuplicate: boolean;
  disabled: boolean;
  gallery: AssistantGalleryView;
  includeEdit: boolean;
  onCopied(copied: boolean): void;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  const run = (action: () => void) => () => {
    setOpen(false);
    const trigger = triggerRef.current;
    trigger?.focus();
    if (!trigger || document.activeElement === trigger) {
      action();
      return;
    }
    // The phone menu is a modal sheet: the trigger stays inert until the
    // sheet has closed and its layer has returned focus there. Acting only
    // then lets a dialog the action opens record the trigger as its opener.
    window.setTimeout(action, 0);
  };
  const { id, owned } = assistant;
  return (
    <span className="v2-assistants-menu">
      <UiV2IconButton
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        icon="more"
        label={`More actions for ${assistant.name}`}
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          label={`Actions for ${assistant.name}`}
          menuRef={menuRef}
          onClose={() => setOpen(false)}
        >
          {owned && includeEdit ? <UiV2MenuItem icon="edit" onClick={run(() => gallery.onEdit(id))}>Edit</UiV2MenuItem> : null}
          {canDuplicate ? <UiV2MenuItem icon="copy" onClick={run(() => gallery.onDuplicate(id))}>Duplicate</UiV2MenuItem> : null}
          <UiV2MenuItem icon="link" onClick={run(() => void gallery.onCopyLink(id).then(onCopied))}>Copy link</UiV2MenuItem>
          {owned && !assistant.archived ? (
            <UiV2MenuItem icon="share" onClick={run(() => gallery.onShare(id))}>Share…</UiV2MenuItem>
          ) : null}
          {owned ? (
            <>
              <UiV2MenuSeparator />
              <UiV2MenuItem
                icon={assistant.archived ? "regenerate" : "archive"}
                onClick={run(() => gallery.onArchiveToggle(id, !assistant.archived))}
              >
                {assistant.archived ? "Restore" : "Archive"}
              </UiV2MenuItem>
              <UiV2MenuItem icon="trash" tone="destructive" onClick={run(() => gallery.onDelete(id))}>Delete</UiV2MenuItem>
            </>
          ) : null}
        </UiV2ResponsiveMenu>
      ) : null}
    </span>
  );
}
