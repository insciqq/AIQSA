"use client";

import { groupLabel } from "@/components/admin/adminViewUtils";
import type { AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import {
  ADMIN_OPEN_INVITES_PREVIEW,
  inviteDeletionInfo,
  inviteDeliveryLabel,
  inviteExpiryLabel,
  inviteStaleLabel
} from "@/components/admin/users/usersView";
import { UsersRowMenu, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { UiV2Button, type UiV2MenuAction } from "@/components/ui-v2";
import type { AdminInviteRecord } from "@/lib/contracts/admin";
import { useId, useState } from "react";

function InviteRow({
  controller,
  invite,
  stale
}: Readonly<{
  controller: AdminInvitesController;
  invite: AdminInviteRecord;
  stale: boolean;
}>) {
  const fresh = controller.fresh?.inviteId === invite.id ? controller.fresh : null;
  const deletion = inviteDeletionInfo(invite, controller.nowMs);
  const detail = [
    groupLabel(invite.defaultGroups),
    stale ? inviteStaleLabel(invite, controller.nowMs) : inviteExpiryLabel(invite, controller.nowMs),
    fresh ? inviteDeliveryLabel(fresh.delivery) : null
  ].filter((part): part is string => part !== null).join(" · ");
  const actions: UiV2MenuAction[] = [
    ...(stale ? [] : [{
      disabled: controller.actionsDisabled,
      icon: "close" as const,
      label: "Revoke",
      onSelect: () => controller.actions.requestRevokeInvite(invite),
      tone: "destructive" as const
    }]),
    {
      disabled: controller.actionsDisabled || !deletion.canDelete,
      icon: "trash",
      label: "Delete",
      onSelect: () => controller.actions.requestDeleteInvite(invite),
      tone: "destructive"
    }
  ];

  return (
    <li
      className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-5"
      data-invite-state={stale ? "stale" : "open"}
      data-testid="admin-invite-row"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{invite.email}</p>
        <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{detail}</p>
        {fresh?.copyError ? (
          <p className="mt-1 text-xs leading-5 text-critical" role="alert">{fresh.copyError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {fresh ? (
          <UiV2Button
            aria-label={`Copy link for ${invite.email}`}
            icon={fresh.copied ? "check" : "copy"}
            onClick={() => void controller.actions.copyFreshLink()}
            tone="ghost"
            type="button"
          >
            {fresh.copied ? "Copied" : "Copy link"}
          </UiV2Button>
        ) : null}
        <UsersRowMenu actions={actions} label={`More actions for ${invite.email}`} />
      </div>
    </li>
  );
}

/**
 * Open invites under the users table (PRD 5.8). Only the invite created in
 * this session still knows its one-time link; older links are hashes and
 * cannot be shown again. Expired and revoked invites wait behind one toggle
 * so they can be deleted.
 */
export function AdminOpenInvites({
  controller,
  expanded
}: Readonly<{
  controller: AdminInvitesController;
  /** The Invited filter shows every open invite without the preview cut. */
  expanded: boolean;
}>) {
  const [showAll, setShowAll] = useState(false);
  const [showStale, setShowStale] = useState(false);
  const headingId = useId();
  const { open, stale } = controller;
  if (open.length === 0 && (expanded || stale.length === 0)) {
    return expanded ? (
      <p className="text-sm text-ink-muted" role="status">No open invites. Use Invite to send one.</p>
    ) : null;
  }
  const shown = expanded || showAll ? open : open.slice(0, ADMIN_OPEN_INVITES_PREVIEW);
  const hidden = open.length - shown.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5" data-testid="admin-open-invites">
      <h2 className={sectionHeadingClass} id={headingId}>Open invites · {open.length}</h2>
      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        {open.length ? (
          <ul aria-label="Open invites" className="divide-y divide-trace-subtle">
            {shown.map((invite) => <InviteRow controller={controller} invite={invite} key={invite.id} />)}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-ink-muted" role="status">No open invites.</p>
        )}
        {hidden > 0 ? (
          <div className="flex justify-center border-t border-trace-subtle px-4 py-2.5">
            <UiV2Button onClick={() => setShowAll(true)} tone="ghost" type="button">Show {hidden} more</UiV2Button>
          </div>
        ) : null}
        {!expanded && stale.length ? (
          <div className="border-t border-trace-subtle">
            <div className="flex items-center justify-between gap-3 px-4 py-2 sm:px-5">
              <p className="text-xs text-ink-muted">
                {stale.length} expired or revoked {stale.length === 1 ? "invite" : "invites"}
              </p>
              <UiV2Button
                aria-expanded={showStale}
                onClick={() => setShowStale((value) => !value)}
                tone="ghost"
                type="button"
              >
                {showStale ? "Hide" : "Show"}
              </UiV2Button>
            </div>
            {showStale ? (
              <ul aria-label="Expired or revoked invites" className="divide-y divide-trace-subtle border-t border-trace-subtle">
                {stale.map((invite) => <InviteRow controller={controller} invite={invite} key={invite.id} stale />)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="text-xs leading-5 text-ink-muted">
        Invite links are one-time: only the invite created just now can still be copied.
      </p>
    </section>
  );
}
