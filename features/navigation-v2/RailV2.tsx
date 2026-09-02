"use client";

import { UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import { AccountMenuV2 } from "./AccountMenuV2";

export type RailSectionV2 = "chats" | "library" | "projects";

function RailButton({
  active = false,
  icon,
  label,
  onClick
}: Readonly<{
  active?: boolean;
  icon: UiV2IconName;
  label: string;
  onClick?(): void;
}>) {
  return (
    <button
      className="v2-rail-button v2-focusable"
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side="right"
      onClick={(event) => {
        // Hide the tooltip once the destination is chosen; it returns after
        // the pointer leaves and comes back (UX audit v2 A10).
        event.currentTarget.setAttribute("data-tooltip-suppressed", "");
        onClick?.();
      }}
      onPointerLeave={(event) => event.currentTarget.removeAttribute("data-tooltip-suppressed")}
    >
      <UiV2Icon name={icon} />
    </button>
  );
}

/**
 * The 56px icon rail (PRD §4.1 / FRONTEND "Chat Composition"): the mark, the
 * permanent destinations, and the account entry. It renders on desktop and
 * compact compositions; the mobile drawer footer carries the same
 * destinations instead.
 */
export function RailV2({
  accountLabel,
  active,
  adminEntryVisible = false,
  onArchivedChats,
  onChats,
  onLibrary,
  onProjects,
  onSettings
}: Readonly<{
  accountLabel?: string | null;
  active: RailSectionV2;
  adminEntryVisible?: boolean;
  onArchivedChats?(): void;
  onChats(): void;
  onLibrary?(): void;
  onProjects?(): void;
  onSettings?(): void;
}>) {
  return (
    <nav className="v2-rail" aria-label="Workspace" data-testid="workspace-rail">
      <span className="v2-rail-brand" aria-hidden="true">
        <UiV2Icon name="brand" />
      </span>
      <div className="v2-rail-group">
        <RailButton active={active === "chats"} icon="chat" label="Chats" onClick={onChats} />
        {onProjects ? (
          <RailButton active={active === "projects"} icon="layers" label="Projects" onClick={onProjects} />
        ) : null}
        {onLibrary ? (
          <RailButton active={active === "library"} icon="library" label="Library" onClick={onLibrary} />
        ) : null}
        {onArchivedChats ? (
          <RailButton icon="archive" label="Archived chats" onClick={onArchivedChats} />
        ) : null}
      </div>
      <div className="v2-rail-group v2-rail-bottom">
        {onSettings ? <RailButton icon="settings" label="Settings" onClick={onSettings} /> : null}
        {adminEntryVisible ? (
          <a
            className="v2-rail-button v2-focusable"
            href="/admin"
            aria-label="Control Center"
            data-tooltip="Control Center"
            data-tooltip-side="right"
          >
            <UiV2Icon name="shield" />
          </a>
        ) : null}
        <AccountMenuV2
          accountLabel={accountLabel}
          adminEntryVisible={adminEntryVisible}
          onSettings={onSettings}
          variant="avatar"
        />
      </div>
    </nav>
  );
}
