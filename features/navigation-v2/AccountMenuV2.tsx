"use client";

import { useControlCenterHref } from "@/components/app-shell/chatRoute";
import { signOutCurrentSession } from "@/components/app-shell/sessionActions";
import {
  UiV2Icon,
  UiV2MenuItem,
  UiV2MenuLink,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useId, useState } from "react";
import { AdminAttentionDot } from "./AdminAttentionDot";
import { adminAttentionIndicator, useAdminAttentionSummary } from "./useAdminAttentionSummary";

/** Two-letter initials for the rail avatar: "operator@aiqsa.local" → "OP". */
export function accountInitialsV2(label: string | null | undefined): string {
  const local = (label ?? "").split("@")[0]?.replace(/[^\p{L}\p{N}]+/gu, " ").trim() ?? "";
  if (!local) return "A";
  const words = local.split(" ").filter(Boolean);
  const initials = words.length > 1
    ? words.slice(0, 2).map((word) => word.slice(0, 1)).join("")
    : local.slice(0, 2);
  return initials.toLocaleUpperCase();
}

/**
 * The one account entry of the shell (UX audit F11): Settings, Control
 * Center, and Sign out. The rail shows it as an avatar; the mobile drawer
 * footer shows it as a row with the account label.
 */
export function AccountMenuV2({
  accountId,
  accountLabel,
  adminEntryVisible = false,
  onSettings,
  variant = "row"
}: Readonly<{
  /** The authenticated viewer; sign-out clears its browser drafts. */
  accountId: string | null;
  accountLabel?: string | null;
  adminEntryVisible?: boolean;
  onSettings?(): void;
  variant?: "avatar" | "row";
}>) {
  const [open, setOpen] = useState(false);
  const controlCenterHref = useControlCenterHref();
  const attention = adminAttentionIndicator(useAdminAttentionSummary(adminEntryVisible));
  // The rail's own Control Center entry carries the dot; the drawer row is the only entry on phones.
  const triggerAttention = variant === "row" ? attention : null;
  const attentionHintId = useId();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setOpen(false),
    open
  });
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    const result = await signOutCurrentSession({ accountId });
    if (!result.ok) {
      setSignOutError(result.error);
      setSigningOut(false);
    }
  };

  return (
    <div className="v2-navigation-account" data-variant={variant}>
      <button
        className="v2-navigation-account-trigger v2-focusable"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        aria-describedby={triggerAttention ? attentionHintId : undefined}
        data-tooltip={variant === "avatar" ? accountLabel || "Account" : undefined}
        data-tooltip-side={variant === "avatar" ? "right" : undefined}
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`v2-navigation-account-avatar${triggerAttention ? " relative" : ""}`} aria-hidden="true">
          {accountInitialsV2(accountLabel)}
          {triggerAttention ? <AdminAttentionDot className="-right-0.5 -top-0.5 ring-workspace-rail" indicator={triggerAttention} /> : null}
        </span>
        {triggerAttention ? <span className="sr-only" id={attentionHintId}>Control Center: {triggerAttention.label}</span> : null}
        {variant === "row" ? (
          <>
            <span className="v2-chat-title">{accountLabel || "Account"}</span>
            <UiV2Icon name="chevron-down" />
          </>
        ) : null}
      </button>
      {open ? (
        <UiV2MenuSurface
          className="v2-navigation-account-menu"
          label="Account"
          ref={menuRef}
        >
          {/* Who is signed in, as ChatGPT/Claude show above their account
              actions; it is a caption, not a menu item. */}
          {accountLabel ? (
            <div className="v2-navigation-account-identity" data-testid="account-menu-identity">
              <span className="v2-navigation-account-avatar" aria-hidden="true">
                {accountInitialsV2(accountLabel)}
              </span>
              <span>{accountLabel}</span>
            </div>
          ) : null}
          {onSettings ? (
            <UiV2MenuItem icon="settings" onClick={() => { setOpen(false); onSettings(); }}>
              Settings
            </UiV2MenuItem>
          ) : null}
          {adminEntryVisible ? (
            <UiV2MenuLink
              aria-label={attention ? `Control Center, ${attention.label}` : undefined}
              href={controlCenterHref}
              icon="monitor"
            >
              Control Center
              {attention ? (
                <span
                  aria-hidden="true"
                  className={`ml-2 inline-flex min-w-5 items-center justify-center rounded-pill px-1.5 text-metadata font-semibold ${
                    attention.severity === "bad" ? "bg-critical/15 text-critical" : "bg-caution/15 text-caution"
                  }`}
                  data-testid="admin-attention-count"
                >
                  {attention.count > 99 ? "99+" : attention.count}
                </span>
              ) : null}
            </UiV2MenuLink>
          ) : null}
          <UiV2MenuItem disabled={signingOut} icon="logout" onClick={() => void signOut()}>
            {signingOut ? "Signing out…" : "Sign out"}
          </UiV2MenuItem>
          {signOutError ? (
            <p className="v2-live-menu-error" role="alert">Could not sign out.</p>
          ) : null}
        </UiV2MenuSurface>
      ) : null}
    </div>
  );
}
