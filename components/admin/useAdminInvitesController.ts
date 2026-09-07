"use client";

import { adminActionErrorMessage } from "@/components/admin/adminApi";
import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import {
  useAdminOneTimeInviteLink,
  type AdminClipboardWriter
} from "@/components/admin/useAdminOneTimeInviteLink";
import { openInvites, staleInvites } from "@/components/admin/users/usersView";
import type { AdminDashboard, AdminInviteEmailDelivery, AdminInviteRecord } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

export type AdminInvitesDashboard = Pick<AdminDashboard, "groups" | "invites">;

export type AdminInviteActionTarget = Pick<AdminInviteRecord, "email" | "id">;

export type AdminInviteCreateInput = Readonly<{
  email: string;
  groupIds: readonly string[];
  sendEmail: boolean;
}>;

export type AdminInviteCreateResult =
  | Readonly<{ delivery: AdminInviteEmailDelivery; ok: true }>
  | Readonly<{ message: string; ok: false }>;

/** The invite created in this session: the only one whose link is still known. */
export type AdminFreshInvite = Readonly<{
  copied: boolean;
  /** Clipboard failure shown next to the link; the page toast is behind the sheet. */
  copyError: string | null;
  delivery: AdminInviteEmailDelivery;
  email: string;
  inviteId: string | null;
  url: string;
}>;

export type UseAdminInvitesControllerOptions = Readonly<{
  actionsDisabled: boolean;
  confirmation: Pick<AdminConfirmationController, "requestConfirmedAction">;
  dashboard: AdminInvitesDashboard | null;
  feedback: Pick<AdminFeedbackController, "clearAll" | "reportError" | "reportNotice">;
  nowMs: number;
  runAction: AdminRunAction;
  writeText?: AdminClipboardWriter;
}>;

export type AdminInvitesController = Readonly<{
  actions: Readonly<{
    copyFreshLink(): Promise<void>;
    createInvite(input: AdminInviteCreateInput): Promise<AdminInviteCreateResult>;
    requestDeleteInvite(invite: AdminInviteActionTarget): void;
    requestRevokeInvite(invite: AdminInviteActionTarget): void;
  }>;
  actionsDisabled: boolean;
  fresh: AdminFreshInvite | null;
  nowMs: number;
  open: AdminInviteRecord[];
  stale: AdminInviteRecord[];
}>;

function inviteEmailDelivery(value: unknown): AdminInviteEmailDelivery | null {
  return value === "failed" || value === "not_requested" || value === "sent" || value === "unavailable"
    ? value
    : null;
}

function createdInviteId(value: unknown): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : null;
}

/**
 * Invites of the Users page: creation from the Invite sheet, the one-time
 * link of the invite created in this session, and the revoke/delete
 * confirmations of the Open invites block.
 */
export function useAdminInvitesController({
  actionsDisabled,
  confirmation,
  dashboard,
  feedback,
  nowMs,
  runAction,
  writeText
}: UseAdminInvitesControllerOptions): AdminInvitesController {
  const { clearAll, reportError, reportNotice } = feedback;
  const { requestConfirmedAction } = confirmation;
  const [copyError, setCopyError] = useState<string | null>(null);
  const linkFeedback = useMemo(() => ({
    clearAll: () => {
      setCopyError(null);
      clearAll();
    },
    reportError: (message: string) => {
      setCopyError(message);
      reportError(message);
    },
    reportNotice
  }), [clearAll, reportError, reportNotice]);
  const inviteLink = useAdminOneTimeInviteLink({ feedback: linkFeedback, writeText });
  const [created, setCreated] = useState<Omit<AdminFreshInvite, "copied" | "copyError" | "url"> | null>(null);
  const groups = dashboard?.groups;

  const createInvite = useCallback(async (input: AdminInviteCreateInput): Promise<AdminInviteCreateResult> => {
    const email = input.email.trim();
    if (!email) {
      return { message: adminActionErrorMessage("email_required"), ok: false };
    }
    const result = await runAction(
      {
        action: "create_invite",
        email,
        groupIds: activeDraftGroupIds(groups ?? [], input.groupIds),
        sendEmail: input.sendEmail
      },
      "Invite created.",
      { successNotice: false }
    );
    if (result.error) {
      return { message: adminActionErrorMessage(result.error), ok: false };
    }
    const delivery = inviteEmailDelivery(result.emailDelivery) ?? (input.sendEmail ? "failed" : "not_requested");
    setCopyError(null);
    setCreated({ delivery, email, inviteId: createdInviteId(result.invite) });
    inviteLink.revealOneTimeUrl(result.inviteUrl);
    if (delivery === "sent") {
      reportNotice("Invite created and email sent.");
    } else if (delivery === "not_requested") {
      reportNotice("Invite created without email. Copy and share the link.");
    } else if (delivery === "unavailable") {
      reportError("Invite created, but email delivery is not configured. Copy and share the link.");
    } else {
      reportError("Invite created, but the email could not be sent. Copy and share the link.");
    }
    return { delivery, ok: true };
  }, [groups, inviteLink, reportError, reportNotice, runAction]);

  const requestRevokeInvite = useCallback((invite: AdminInviteActionTarget) => {
    requestConfirmedAction({
      body: { action: "revoke_invite", inviteId: invite.id },
      confirmLabel: "Revoke invite",
      dialogLabel: `Revoke invite for ${invite.email}`,
      icon: "x",
      message: "Invite revoked.",
      prompt: `Revoke the open invite for ${invite.email}? The invite link will stop working.`,
      testId: "admin-confirm-revoke-invite",
      title: "Revoke invite?",
      tone: "warning"
    });
  }, [requestConfirmedAction]);

  const requestDeleteInvite = useCallback((invite: AdminInviteActionTarget) => {
    requestConfirmedAction({
      body: { action: "delete_invite", inviteId: invite.id },
      confirmLabel: "Delete invite",
      dialogLabel: `Delete invite for ${invite.email}`,
      icon: "trash",
      message: "Invite deleted.",
      prompt: `Delete the stale invite for ${invite.email}? Expired or revoked invite records and their hashed tokens will be removed.`,
      testId: "admin-confirm-delete-invite",
      title: "Delete stale invite?"
    });
  }, [requestConfirmedAction]);

  const invites = dashboard?.invites;
  const open = useMemo(() => openInvites(invites ?? [], nowMs), [invites, nowMs]);
  const stale = useMemo(() => staleInvites(invites ?? [], nowMs), [invites, nowMs]);
  const fresh = useMemo<AdminFreshInvite | null>(() => {
    if (!created || !inviteLink.oneTimeUrl) return null;
    // A revoked or accepted invite takes its link with it.
    const record = created.inviteId ? invites?.find((invite) => invite.id === created.inviteId) : undefined;
    if (record && (record.revokedAt || record.acceptedAt)) return null;
    return { ...created, copied: inviteLink.oneTimeUrlCopied, copyError, url: inviteLink.oneTimeUrl };
  }, [copyError, created, inviteLink.oneTimeUrl, inviteLink.oneTimeUrlCopied, invites]);

  return useMemo(() => ({
    actions: {
      copyFreshLink: inviteLink.copyOneTimeUrl,
      createInvite,
      requestDeleteInvite,
      requestRevokeInvite
    },
    actionsDisabled,
    fresh,
    nowMs,
    open,
    stale
  }), [
    actionsDisabled,
    createInvite,
    fresh,
    inviteLink.copyOneTimeUrl,
    nowMs,
    open,
    requestDeleteInvite,
    requestRevokeInvite,
    stale
  ]);
}
