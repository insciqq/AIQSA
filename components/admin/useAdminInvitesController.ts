"use client";

import type { AdminInvitesSectionProps } from "@/components/admin/AdminInvitesSection";
import { activeDraftGroupIds } from "@/components/admin/adminDraftGroups";
import {
  filterAdminInvites,
  type AdminInviteStatusFilter
} from "@/components/admin/adminInviteView";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import type { AdminFieldErrorController } from "@/components/admin/useAdminFieldErrors";
import {
  useAdminOneTimeInviteLink,
  type AdminClipboardWriter
} from "@/components/admin/useAdminOneTimeInviteLink";
import type { AdminDashboard, AdminInviteEmailDelivery } from "@/lib/contracts/admin";
import { useCallback, useMemo, useState } from "react";

export type AdminInvitesDashboard = Pick<AdminDashboard, "groups" | "invites">;

export type AdminInvitesHeaderForm = Readonly<{
  formOpen: boolean;
  toggleForm(): void;
}>;

export type UseAdminInvitesControllerOptions = Readonly<{
  actionsDisabled: boolean;
  confirmation: Pick<AdminConfirmationController, "requestConfirmedAction">;
  dashboard: AdminInvitesDashboard | null;
  feedback: Pick<AdminFeedbackController, "clearAll" | "reportError" | "reportNotice">;
  fieldErrors: Pick<AdminFieldErrorController, "clearFieldError" | "fieldError" | "reportFieldError">;
  nowMs: number;
  runAction: AdminRunAction;
  writeText?: AdminClipboardWriter;
}>;

export type AdminInvitesController = Readonly<{
  headerForm: AdminInvitesHeaderForm;
  sectionProps: AdminInvitesSectionProps | null;
}>;

function inviteEmailDelivery(value: unknown): AdminInviteEmailDelivery | null {
  return value === "failed" || value === "not_requested" || value === "sent" || value === "unavailable"
    ? value
    : null;
}

export function useAdminInvitesController({
  actionsDisabled,
  confirmation,
  dashboard,
  feedback,
  fieldErrors,
  nowMs,
  runAction,
  writeText
}: UseAdminInvitesControllerOptions): AdminInvitesController {
  const { clearFieldError, fieldError, reportFieldError } = fieldErrors;
  const { reportError, reportNotice } = feedback;
  const { requestConfirmedAction } = confirmation;
  const [email, setEmail] = useState("");
  const [emailDelivery, setEmailDelivery] = useState<AdminInviteEmailDelivery | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [statusFilter, setStatusFilter] = useState<AdminInviteStatusFilter>("all");
  const inviteLink = useAdminOneTimeInviteLink({ feedback, writeText });
  const projectedGroupIds = useMemo(
    () => activeDraftGroupIds(dashboard?.groups ?? [], groupIds),
    [dashboard?.groups, groupIds]
  );
  const filteredInvites = useMemo(
    () => filterAdminInvites(dashboard?.invites ?? [], query, statusFilter, nowMs),
    [dashboard?.invites, nowMs, query, statusFilter]
  );

  const toggleForm = useCallback(() => {
    clearFieldError("invite-email");
    setFormOpen((open) => !open);
  }, [clearFieldError]);

  const changeEmail = useCallback(
    (value: string) => {
      setEmail(value);
      clearFieldError("invite-email");
    },
    [clearFieldError]
  );

  const createInvite = useCallback(async () => {
    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      reportFieldError("invite-email", "email_required");
      return;
    }
    clearFieldError("invite-email");

    const result = await runAction(
      {
        action: "create_invite",
        email: normalizedEmail,
        groupIds: projectedGroupIds,
        sendEmail
      },
      "Invite created.",
      { successNotice: false }
    );

    if (!result.error) {
      const delivery = inviteEmailDelivery(result.emailDelivery) ?? (sendEmail ? "failed" : "not_requested");
      setEmail("");
      setEmailDelivery(delivery);
      setGroupIds([]);
      setSendEmail(true);
      inviteLink.revealOneTimeUrl(result.inviteUrl);

      if (delivery === "sent") {
        reportNotice("Invite created and email sent.");
      } else if (delivery === "not_requested") {
        reportNotice("Invite created without email. Copy and share the link below.");
      } else if (delivery === "unavailable") {
        reportError("Invite created, but email delivery is not configured. Copy and share the link below.");
      } else {
        reportError("Invite created, but the email could not be sent. Copy and share the link below.");
      }
    }
  }, [
    clearFieldError,
    email,
    inviteLink,
    projectedGroupIds,
    reportError,
    reportFieldError,
    reportNotice,
    runAction,
    sendEmail
  ]);

  const requestRevokeInvite = useCallback(
    (invite: Parameters<AdminInvitesSectionProps["actions"]["requestRevokeInvite"]>[0]) => {
      requestConfirmedAction({
        body: {
          action: "revoke_invite",
          inviteId: invite.id
        },
        confirmLabel: "Revoke invite",
        dialogLabel: `Revoke invite for ${invite.email}`,
        message: "Invite revoked.",
        prompt: `Revoke the open invite for ${invite.email}? The invite link will stop working.`,
        testId: "admin-confirm-revoke-invite",
        title: "Revoke invite?"
      });
    },
    [requestConfirmedAction]
  );

  const requestDeleteInvite = useCallback(
    (invite: Parameters<AdminInvitesSectionProps["actions"]["requestDeleteInvite"]>[0]) => {
      requestConfirmedAction({
        body: {
          action: "delete_invite",
          inviteId: invite.id
        },
        confirmLabel: "Delete invite",
        dialogLabel: `Delete invite for ${invite.email}`,
        icon: "trash",
        message: "Invite deleted.",
        prompt: `Delete the stale invite for ${invite.email}? Expired or revoked invite records and their hashed tokens will be removed.`,
        testId: "admin-confirm-delete-invite",
        title: "Delete stale invite?"
      });
    },
    [requestConfirmedAction]
  );

  const sectionProps = useMemo<AdminInvitesSectionProps | null>(() => {
    if (!dashboard) {
      return null;
    }

    return {
      actions: {
        changeEmail,
        changeGroups: setGroupIds,
        changeQuery: setQuery,
        changeSendEmail: setSendEmail,
        changeStatusFilter: setStatusFilter,
        copyOneTimeUrl: inviteLink.copyOneTimeUrl,
        createInvite,
        requestDeleteInvite,
        requestRevokeInvite
      },
      data: {
        groups: dashboard.groups,
        invites: filteredInvites,
        nowMs,
        totalInviteCount: dashboard.invites.length
      },
      state: {
        email,
        emailDelivery,
        emailError: fieldError?.field === "invite-email" ? fieldError.message : null,
        formOpen,
        groupIds: projectedGroupIds,
        oneTimeUrl: inviteLink.oneTimeUrl,
        oneTimeUrlCopied: inviteLink.oneTimeUrlCopied,
        query,
        sendEmail,
        statusFilter
      },
      status: {
        actionsDisabled
      }
    };
  }, [
    actionsDisabled,
    changeEmail,
    createInvite,
    dashboard,
    email,
    emailDelivery,
    fieldError,
    filteredInvites,
    formOpen,
    inviteLink.copyOneTimeUrl,
    inviteLink.oneTimeUrl,
    inviteLink.oneTimeUrlCopied,
    nowMs,
    projectedGroupIds,
    query,
    requestDeleteInvite,
    requestRevokeInvite,
    sendEmail,
    statusFilter
  ]);

  return useMemo(
    () => ({
      headerForm: {
        formOpen,
        toggleForm
      },
      sectionProps
    }),
    [formOpen, sectionProps, toggleForm]
  );
}
