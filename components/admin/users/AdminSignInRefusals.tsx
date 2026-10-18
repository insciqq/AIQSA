"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import type { AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import {
  ADMIN_SIGN_IN_REFUSALS_PREVIEW,
  signInRefusalPresentation
} from "@/components/admin/users/signInRefusalsView";
import {
  useAdminSignInRefusals,
  type AdminSignInRefusalsRequest
} from "@/components/admin/users/useAdminSignInRefusals";
import { UsersTag, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { UiV2Button } from "@/components/ui-v2";
import {
  SIGN_IN_REFUSAL_RETENTION_DAYS,
  type AdminSignInRefusal
} from "@/lib/contracts/adminSignInRefusals";
import { useId, useMemo, useState, type MouseEvent } from "react";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function RefusalRow({
  invitesDisabled,
  invitedEmails,
  onInvite,
  onOpenUser,
  refusal
}: Readonly<{
  invitesDisabled: boolean;
  invitedEmails: ReadonlySet<string>;
  onInvite(email: string): void;
  onOpenUser(userId: string): void;
  refusal: AdminSignInRefusal;
}>) {
  const row = signInRefusalPresentation(refusal);
  const { account, invitableEmail } = row;
  return (
    <li
      className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-5"
      data-subject={refusal.subject.kind}
      data-testid="admin-sign-in-refusal"
    >
      <div className="min-w-0 flex-1">
        <p className={`break-words text-sm font-medium [overflow-wrap:anywhere] ${row.muted ? "text-ink-secondary" : "text-ink"}`}>
          {row.title}
        </p>
        <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{row.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {invitableEmail && invitedEmails.has(invitableEmail) ? <UsersTag>Invited</UsersTag> : null}
        {invitableEmail && !invitedEmails.has(invitableEmail) ? (
          <UiV2Button
            aria-label={`Invite ${invitableEmail}`}
            disabled={invitesDisabled}
            icon="plus"
            onClick={() => onInvite(invitableEmail)}
            tone="ghost"
            type="button"
          >
            Invite
          </UiV2Button>
        ) : null}
        {account ? (
          <a
            aria-label={`Open user ${account.displayName}`}
            className="v2-button v2-focusable"
            data-tone="ghost"
            href={adminSectionPath(currentHref(), "users", account.id)}
            onClick={(event) => {
              if (!primaryClick(event)) return;
              event.preventDefault();
              onOpenUser(account.id);
            }}
          >
            <span>Open user</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Refused sign-ins of the last 30 days under the users table and open invites (Sign-in owns
 * what is recorded): one row per day, method, reason and person, with its attempts. Invite opens
 * the Invite sheet with the verified email of someone without an account; Open user opens the
 * account a refusal names.
 */
export function AdminSignInRefusals({
  invites,
  onInvite,
  onOpenUser,
  request
}: Readonly<{
  invites: Pick<AdminInvitesController, "actionsDisabled" | "open">;
  onInvite(email: string): void;
  onOpenUser(userId: string): void;
  /** The read; the Users page's own by default. */
  request?: AdminSignInRefusalsRequest;
}>) {
  const controller = useAdminSignInRefusals(request);
  const [showAll, setShowAll] = useState(false);
  const headingId = useId();
  const invitedEmails = useMemo(() => new Set(invites.open.map((invite) => invite.normalizedEmail)), [invites.open]);
  const { page } = controller;
  const refusals = page?.refusals ?? [];
  const shown = showAll ? refusals : refusals.slice(0, ADMIN_SIGN_IN_REFUSALS_PREVIEW);
  const hidden = refusals.length - shown.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5" data-testid="admin-sign-in-refusals">
      <h2 className={sectionHeadingClass} id={headingId}>
        Refused sign-ins{page ? ` · ${page.total}` : ""}
      </h2>
      <div
        aria-busy={controller.loading || undefined}
        className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper"
      >
        {controller.loading ? (
          <p className="px-5 py-4 text-sm text-ink-muted">Loading refused sign-ins…</p>
        ) : !page ? (
          <div className="flex flex-wrap items-center gap-3 px-5 py-4" data-testid="admin-sign-in-refusals-unavailable">
            <p className="min-w-0 flex-1 text-sm text-ink">Refused sign-ins could not be loaded.</p>
            <UiV2Button onClick={controller.refresh} tone="ghost" type="button">Try again</UiV2Button>
          </div>
        ) : refusals.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted" data-testid="admin-sign-in-refusals-empty">
            No refused sign-ins in the last {SIGN_IN_REFUSAL_RETENTION_DAYS} days.
          </p>
        ) : (
          <ul aria-label="Refused sign-ins" className="divide-y divide-trace-subtle">
            {shown.map((refusal) => (
              <RefusalRow
                invitedEmails={invitedEmails}
                invitesDisabled={invites.actionsDisabled}
                key={refusal.id}
                onInvite={onInvite}
                onOpenUser={onOpenUser}
                refusal={refusal}
              />
            ))}
          </ul>
        )}
        {hidden > 0 ? (
          <div className="flex justify-center border-t border-trace-subtle px-4 py-2.5">
            <UiV2Button onClick={() => setShowAll(true)} tone="ghost" type="button">Show {hidden} more</UiV2Button>
          </div>
        ) : null}
      </div>
      {page?.truncated ? (
        <p className="text-xs text-ink-muted">
          Showing the newest {refusals.length} of {page.total}.
        </p>
      ) : null}
      <p className="text-xs leading-5 text-ink-muted">
        Kept for {SIGN_IN_REFUSAL_RETENTION_DAYS} days. An email is recorded only when the sign-in method verified it;
        password and two-factor attempts only for existing accounts.
      </p>
    </section>
  );
}
