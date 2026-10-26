"use client";

import { useControlCenterHref } from "@/components/app-shell/chatRoute";
import type { MouseEvent, PointerEvent } from "react";
import { UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import { shellLinkClick } from "@/features/answer-outputs-v2/shellLinkClick";
import { CONNECT_PAGE_PATH } from "@/lib/contracts/connect";
import { NEW_CHAT_PATH } from "@/lib/domain/chatRoute";
import { AccountMenuV2 } from "./AccountMenuV2";
import { AnnouncementsBell } from "@/components/announcements/AnnouncementsBell";
import { AdminAttentionDot } from "./AdminAttentionDot";
import { adminAttentionIndicator, useAdminAttentionSummary } from "./useAdminAttentionSummary";

export type RailSectionV2 = "chats" | "library";

function RailButton({
  active = false,
  className = "",
  disabled = false,
  href,
  icon,
  label,
  onClick
}: Readonly<{
  active?: boolean;
  className?: string;
  disabled?: boolean;
  /** Makes the entry a link that a plain click still opens in place with `onClick`. */
  href?: string;
  icon: UiV2IconName;
  label: string;
  onClick?(): void;
}>) {
  const shared = {
    className: `v2-rail-button v2-focusable ${className}`,
    "aria-current": active ? "page" as const : undefined,
    "aria-label": label,
    "data-tooltip": label,
    "data-tooltip-side": "right",
    onPointerLeave: (event: PointerEvent<HTMLElement>) => event.currentTarget.removeAttribute("data-tooltip-suppressed")
  };
  // Hide the tooltip once the destination is chosen; it returns after the
  // pointer leaves and comes back (UX audit v2 A10).
  const suppressTooltip = (event: MouseEvent<HTMLElement>) =>
    event.currentTarget.setAttribute("data-tooltip-suppressed", "");
  if (href) {
    const openInPlace = shellLinkClick(() => {
      if (!disabled) onClick?.();
    });
    return (
      <a
        {...shared}
        href={href}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          suppressTooltip(event);
          openInPlace(event);
        }}
      >
        <UiV2Icon name={icon} />
      </a>
    );
  }
  return (
    <button
      {...shared}
      type="button"
      disabled={disabled}
      onClick={(event) => {
        suppressTooltip(event);
        onClick?.();
      }}
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
  connectEntryVisible = false,
  navigationBusy = false,
  onChats,
  onLibrary,
  onNewChat,
  onSettings
}: Readonly<{
  accountId?: string | null;
  accountLabel?: string | null;
  active: RailSectionV2;
  adminEntryVisible?: boolean;
  /** AIQSA Connect is on for this installation: its mode opens as its own page. */
  connectEntryVisible?: boolean;
  navigationBusy?: boolean;
  onChats(): void;
  onLibrary?(): void;
  onNewChat(): void;
  onSettings?(): void;
}>) {
  // Control Center returns to the chat it was opened from.
  const controlCenterHref = useControlCenterHref();
  const attention = adminAttentionIndicator(useAdminAttentionSummary(adminEntryVisible));
  return (
    <nav className="v2-rail" aria-label="Workspace" data-testid="workspace-rail">
      <RailButton disabled={navigationBusy} className="v2-rail-brand" href={NEW_CHAT_PATH} icon="brand" label="New chat" onClick={onNewChat} />
      <div className="v2-rail-group">
        <RailButton disabled={navigationBusy} active={active === "chats"} icon="chat" label="Chats" onClick={onChats} />
        {onLibrary ? (
          <RailButton disabled={navigationBusy} active={active === "library"} icon="studio" label="Studio" onClick={onLibrary} />
        ) : null}
        {connectEntryVisible ? (
          <a
            className="v2-rail-button v2-focusable"
            href={CONNECT_PAGE_PATH}
            aria-label="AIQSA Connect"
            data-tooltip="AIQSA Connect"
            data-tooltip-side="right"
          >
            <UiV2Icon name="terminal" />
          </a>
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
          onSettings={onSettings}
          variant="avatar"
        />
      </div>
    </nav>
  );
}
