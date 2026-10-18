"use client";

import { UiV2IconButton, UiV2MenuActions, type UiV2MenuAction } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState } from "react";

/** A `⋯` button with one action list: anchored on desktop, a sheet on phones. */
export function ConnectMenu({ actions, label }: Readonly<{ actions: readonly UiV2MenuAction[]; label: string }>) {
  const [open, setOpen] = useState(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  return (
    <>
      <UiV2IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        icon="more"
        label={label}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      />
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} label={label} menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuActions actions={actions} onClose={closeForAction} />
        </UiV2ResponsiveMenu>
      ) : null}
    </>
  );
}
