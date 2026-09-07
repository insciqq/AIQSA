"use client";

import { AdminGroupOptions, inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import type { AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import { inviteDeliveryLabel } from "@/components/admin/users/usersView";
import { fieldLabelClass, helpTextClass } from "@/components/admin/users/usersPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup, AdminInviteEmailDelivery } from "@/lib/contracts/admin";
import { useId, useRef, useState } from "react";

type CreatedInvite = Readonly<{ delivery: AdminInviteEmailDelivery; email: string }>;

function deliveryCopy(delivery: AdminInviteEmailDelivery): string {
  switch (delivery) {
    case "sent":
      return "The invitation email was sent. Copy the link too if you want a manual fallback.";
    case "unavailable":
      return "Email delivery is not configured. Share this link yourself.";
    case "failed":
      return "The email could not be sent. Share this link yourself.";
    case "not_requested":
      return "No email was sent. Share this link yourself.";
  }
}

function InviteSheetBody({
  controller,
  groups,
  onClose
}: Readonly<{
  controller: AdminInvitesController;
  groups: readonly AdminGroup[];
  onClose(): void;
}>) {
  const [email, setEmail] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [sendEmail, setSendEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const emailId = useId();
  const errorId = useId();
  const linkId = useId();
  const busy = controller.actionsDisabled || submitting;
  const dirty = !created && (email !== "" || groupIds.length > 0 || !sendEmail);
  const fresh = created && controller.fresh?.email === created.email ? controller.fresh : null;

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    setError(null);
    if (!email.trim()) {
      setError("Enter the person's email address.");
      emailRef.current?.focus();
      return;
    }
    setSubmitting(true);
    const result = await controller.actions.createInvite({ email, groupIds, sendEmail });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      emailRef.current?.focus();
      return;
    }
    setCreated({ delivery: result.delivery, email: email.trim() });
  };

  const inviteAnother = () => {
    setCreated(null);
    setEmail("");
    setGroupIds([]);
    setSendEmail(true);
    setError(null);
  };

  return (
    <AdminSheet
      closeBlocked={busy}
      description={created
        ? "The link works once and cannot be shown again after this sheet closes."
        : "The person gets a one-time link to create their account."}
      footer={created ? (
        <>
          <UiV2Button onClick={onClose} tone="primary" type="button">Done</UiV2Button>
          <UiV2Button onClick={inviteAnother} tone="ghost" type="button">Invite another</UiV2Button>
        </>
      ) : (
        <>
          <UiV2Button busy={submitting} disabled={busy} form={formId} tone="primary" type="submit">
            Create invite
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
        </>
      )}
      onClose={requestClose}
      open
      testId="admin-invite-sheet"
      title="Invite"
    >
      {created ? (
        <div className="flex flex-col gap-4" data-testid="admin-invite-result">
          <p className="text-sm text-ink">
            <span className="font-medium">{created.email}</span> is invited · {inviteDeliveryLabel(created.delivery)}.
          </p>
          <p className={helpTextClass}>{deliveryCopy(created.delivery)}</p>
          {fresh ? (
            <div>
              <label className={fieldLabelClass} htmlFor={linkId}>Invite link</label>
              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  className={`${inputClass} font-mono text-xs`}
                  id={linkId}
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={fresh.url}
                />
                <UiV2Button
                  icon={fresh.copied ? "check" : "copy"}
                  onClick={() => void controller.actions.copyFreshLink()}
                  tone="ghost"
                  type="button"
                >
                  {fresh.copied ? "Copied" : "Copy"}
                </UiV2Button>
              </div>
              {fresh.copyError ? (
                <p className="mt-1.5 text-xs leading-5 text-critical" role="alert">{fresh.copyError}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs leading-5 text-caution" role="status">
              The link is no longer available; create a new invite if it is still needed.
            </p>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <label className={fieldLabelClass} htmlFor={emailId}>Email</label>
            <input
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              className={inputClass}
              disabled={busy}
              id={emailId}
              inputMode="email"
              onChange={(event) => {
                setEmail(event.currentTarget.value);
                setError(null);
              }}
              placeholder="person@example.com"
              ref={emailRef}
              spellCheck={false}
              type="email"
              value={email}
            />
            {error ? (
              <p className="mt-1.5 text-xs leading-5 text-critical" id={errorId} role="alert">{error}</p>
            ) : null}
          </div>
          <AdminGroupOptions groups={[...groups]} label="Groups" onChange={setGroupIds} selected={groupIds} />
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              checked={sendEmail}
              className="mt-1 size-4 shrink-0 accent-proof"
              disabled={busy}
              onChange={(event) => setSendEmail(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              Send invitation email
              <span className={helpTextClass}>Uses the configured SMTP server. The link is shown here either way.</span>
            </span>
          </label>
        </form>
      )}
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved invite"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="admin-invite-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          The invite has not been created yet; what you typed will be lost.
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/**
 * Invite sheet (PRD 5.8): email, groups and whether to send the email; after
 * creation the same sheet shows the one-time link with Copy and the delivery
 * outcome. The discard dialog lives inside the sheet because the page behind
 * an open sheet is inert.
 */
export function AdminInviteSheet({
  controller,
  groups,
  onClose,
  open
}: Readonly<{
  controller: AdminInvitesController;
  groups: readonly AdminGroup[];
  onClose(): void;
  open: boolean;
}>) {
  if (!open) return null;
  return <InviteSheetBody controller={controller} groups={groups} onClose={onClose} />;
}
