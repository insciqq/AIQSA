"use client";

import { useControlCenterHref } from "@/components/app-shell/chatRoute";
import { UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import { AccountMenuV2 } from "./AccountMenuV2";
import { AnnouncementsBell } from "@/components/announcements/AnnouncementsBell";
import { AdminAttentionDot } from "./AdminAttentionDot";
import { adminAttentionIndicator, useAdminAttentionSummary } from "./useAdminAttentionSummary";

export type RailSectionV2 = "chats" | "library" | "projects";

function RailButton({
  active = false,
  className = "",
  disabled = false,
  icon,
  label,
  onClick
}: Readonly<{
  active?: boolean;
  className?: string;
  disabled?: boolean;
  icon: UiV2IconName;
  label: string;
  onClick?(): void;
}>) {
  return (
    <button
      className={`v2-rail-button v2-focusable ${className}`}
      type="button"
      disabled={disabled}
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
  accountId = null,
  accountLabel,
  active,
  adminEntryVisible = false,
  navigationBusy = false,
  onChats,
  onLibrary,
  onNewChat,
  onAccountSettings,
  onProjects,
  onSettings
}: Readonly<{
  accountId?: string | null;
  accountLabel?: string | null;
  active: RailSectionV2;
  adminEntryVisible?: boolean;
  navigationBusy?: boolean;
  onChats(): void;
  onLibrary?(): void;
  onNewChat(): void;
  onProjects?(): void;
  onSettings?(): void;
  /** The account menu's Settings; defaults to `onSettings`. */
  onAccountSettings?(): void;
}>) {
  // Control Center returns to the chat it was opened from.
  const controlCenterHref = useControlCenterHref();
  const attention = adminAttentionIndicator(useAdminAttentionSummary(adminEntryVisible));
  return (
    <nav className="v2-rail" aria-label="Workspace" data-testid="workspace-rail">
      <RailButton disabled={navigationBusy} className="v2-rail-brand" icon="brand" label="New chat" onClick={onNewChat} />
      <div className="v2-rail-group">
        <RailButton disabled={navigationBusy} active={active === "chats"} icon="chat" label="Chats" onClick={onChats} />
        {onProjects ? (
          <RailButton disabled={navigationBusy} active={active === "projects"} icon="layers" label="Projects" onClick={onProjects} />
        ) : null}
        {onLibrary ? (
          <RailButton disabled={navigationBusy} active={active === "library"} icon="studio" label="Studio" onClick={onLibrary} />
        ) : null}
      </div>
      <div className="v2-rail-group v2-rail-bottom">
        <AnnouncementsBell />
        {onSettings ? <RailButton icon="settings" label="Settings" onClick={onSettings} /> : null}
        {adminEntryVisible ? (
          <a
            className="v2-rail-button v2-focusable relative"
            href={controlCenterHref}
            aria-label={attention ? `Control Center, ${attention.label}` : "Control Center"}
            data-tooltip={attention ? `Control Center · ${attention.label}` : "Control Center"}
            data-tooltip-side="right"
          >
            <UiV2Icon name="shield" />
            {attention ? <AdminAttentionDot indicator={attention} /> : null}
          </a>
        ) : null}
        <AccountMenuV2
          accountId={accountId}
          accountLabel={accountLabel}
          adminEntryVisible={adminEntryVisible}
          onSettings={onAccountSettings ?? onSettings}
          variant="avatar"
        />
      </div>
    </nav>
  );
}
