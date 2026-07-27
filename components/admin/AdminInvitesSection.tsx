import {
  AdminGroupOptions,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  EmptyState,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  inviteDeletionInfo,
  inviteStatus,
  inviteStatusClass,
  inviteStatusLabel,
  isInviteOpen,
  type AdminInviteStatusFilter
} from "@/components/admin/adminInviteView";
import { formatDate, groupLabel } from "@/components/admin/adminViewUtils";
import type { AdminGroup, AdminInviteEmailDelivery, AdminInviteRecord } from "@/lib/contracts/admin";
import { Copy, Link2, Search, Trash2 } from "lucide-react";

export type AdminInviteActionTarget = Pick<AdminInviteRecord, "email" | "id">;

export type AdminInvitesSectionData = Readonly<{
  groups: AdminGroup[];
  invites: AdminInviteRecord[];
  nowMs: number;
  selectedInvite: AdminInviteRecord | null;
  totalInviteCount: number;
}>;

export type AdminInvitesSectionState = Readonly<{
  compactDetailOpen: boolean;
  email: string;
  emailDelivery: AdminInviteEmailDelivery | null;
  emailError: string | null;
  formOpen: boolean;
  groupIds: string[];
  oneTimeUrl: string | null;
  oneTimeUrlCopied: boolean;
  query: string;
  sendEmail: boolean;
  statusFilter: AdminInviteStatusFilter;
}>;

export type AdminInvitesSectionStatus = Readonly<{
  actionsDisabled: boolean;
}>;

export type AdminInvitesSectionActions = Readonly<{
  backToList(): void;
  changeEmail(value: string): void;
  changeGroups(groupIds: string[]): void;
  changeQuery(value: string): void;
  changeSendEmail(value: boolean): void;
  changeStatusFilter(status: AdminInviteStatusFilter): void;
  copyOneTimeUrl(): Promise<void> | void;
  createInvite(): Promise<void> | void;
  requestDeleteInvite(invite: AdminInviteActionTarget): void;
  requestRevokeInvite(invite: AdminInviteActionTarget): void;
  selectInvite(inviteId: string): void;
}>;

export type AdminInvitesSectionProps = Readonly<{
  actions: AdminInvitesSectionActions;
  data: AdminInvitesSectionData;
  state: AdminInvitesSectionState;
  status: AdminInvitesSectionStatus;
}>;

const inviteFilterLabels: Record<AdminInviteStatusFilter, string> = {
  accepted: "Accepted",
  all: "All",
  expired: "Expired",
  open: "Open",
  revoked: "Revoked",
  soon: "Expiring soon"
};

function inviteLinkDeliveryCopy(delivery: AdminInviteEmailDelivery | null): string {
  if (delivery === "sent") return "The invitation email was sent. Copy this link now if you also want a manual fallback; it cannot be recovered later.";
  if (delivery === "unavailable") return "Email delivery is not configured. Copy and share this create-account link now; it cannot be recovered later.";
  if (delivery === "failed") return "The email could not be sent. Copy and share this create-account link now; it cannot be recovered later.";
  if (delivery === "not_requested") return "No invitation email was sent. Copy and share this create-account link now; it cannot be recovered later.";
  return "Copy this create-account link now. Existing invite tokens are stored as hashes and cannot be recovered later.";
}

function InviteCreateTask({ actions, data, state, status }: AdminInvitesSectionProps) {
  return (
    <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <AdminTaskBackButton label="Back to invites" onClick={actions.backToList} />
      <div className="max-w-2xl border-b border-trace-subtle pb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">New invite</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">Invite one person</h3>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Email delivery is selected by default. The fresh link is shown once for manual copy in every outcome.
        </p>
      </div>
      <form
        className="mt-5 grid max-w-2xl gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.createInvite();
        }}
      >
        <div>
          <label className="text-xs font-medium text-ink-secondary" htmlFor="invite-email">Email</label>
          <input
            aria-describedby={state.emailError ? "invite-email-error" : undefined}
            aria-invalid={state.emailError ? true : undefined}
            className={`${inputClass} mt-1.5`}
            id="invite-email"
            onChange={(event) => actions.changeEmail(event.currentTarget.value)}
            type="email"
            value={state.email}
          />
          {state.emailError ? <p className="mt-2 text-xs text-critical" id="invite-email-error">{state.emailError}</p> : null}
        </div>
        <AdminGroupOptions groups={data.groups} label="Default groups" onChange={actions.changeGroups} selected={state.groupIds} />
        <label className="flex min-h-touch items-start gap-3 border-y border-trace-subtle py-3 text-xs text-ink-secondary">
          <input
            aria-label="Send invitation email"
            aria-describedby="invite-email-delivery-help"
            checked={state.sendEmail}
            className="mt-0.5 size-4 shrink-0 accent-proof"
            id="invite-send-email"
            onChange={(event) => actions.changeSendEmail(event.currentTarget.checked)}
            type="checkbox"
          />
          <span className="min-w-0">
            <span className="block font-medium text-ink">Send invitation email</span>
            <span className="mt-0.5 block leading-5 text-ink-muted" id="invite-email-delivery-help">
              Uses configured SMTP. The fresh link will still appear below for manual copy.
            </span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
            <Link2 aria-hidden="true" className="size-3.5" /> Create invite
          </button>
          <button className={quietButton} onClick={actions.backToList} type="button">Cancel</button>
        </div>
      </form>

      {state.oneTimeUrl ? (
        <section className="mt-6 max-w-2xl border-l-2 border-proof bg-proof/5 px-3 py-3">
          <h4 className="text-sm font-semibold text-proof">New invite link</h4>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">{inviteLinkDeliveryCopy(state.emailDelivery)}</p>
          <label className="mt-3 block text-xs text-ink-muted">
            Invite create-account link
            <div className="mt-1.5 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input className={`${inputClass} font-mono text-xs`} readOnly value={state.oneTimeUrl} />
              <button className={quietButton} onClick={() => void actions.copyOneTimeUrl()} type="button">
                <Copy aria-hidden="true" className="size-3.5" /> {state.oneTimeUrlCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </label>
        </section>
      ) : null}
    </div>
  );
}

function InviteDetail({ actions, invite, nowMs, status }: Readonly<{
  actions: AdminInvitesSectionActions;
  invite: AdminInviteRecord | null;
  nowMs: number;
  status: AdminInvitesSectionStatus;
}>) {
  if (!invite) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <AdminTaskBackButton label="Back to invites" onClick={actions.backToList} />
        <EmptyState detail="Select an invite to review its lifecycle and available actions." title="No invite selected" />
      </div>
    );
  }

  const currentStatus = inviteStatus(invite, nowMs);
  const deletion = inviteDeletionInfo(invite, nowMs);

  return (
    <article className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-testid="admin-invite-detail">
      <AdminTaskBackButton label="Back to invites" onClick={actions.backToList} />
      <div className="flex min-w-0 items-start justify-between gap-4 border-b border-trace-subtle pb-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Invite</p>
          <h3 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{invite.email}</h3>
          <p className="mt-2 text-sm text-ink-secondary">
            {invite.acceptedAt
              ? `Accepted ${formatDate(invite.acceptedAt)}`
              : invite.revokedAt
                ? `Revoked ${formatDate(invite.revokedAt)}`
                : `Expires ${formatDate(invite.expiresAt)}`}
          </p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${inviteStatusClass(currentStatus)}`}>
          {inviteStatusLabel(currentStatus)}
        </span>
      </div>
      <section className="border-b border-trace-subtle py-5">
        <h4 className="text-sm font-semibold text-ink">Default groups</h4>
        <p className="mt-2 break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{groupLabel(invite.defaultGroups)}</p>
      </section>
      <section className="py-5">
        <h4 className="text-sm font-semibold text-ink">Invite actions</h4>
        <p className="mt-1 max-w-xl text-xs leading-5 text-ink-muted">
          Existing invite links cannot be recovered from history because stored tokens are hashes.
        </p>
        <div className="mt-3 grid max-w-xl gap-2">
          {isInviteOpen(invite, nowMs) ? (
            <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.requestRevokeInvite({ email: invite.email, id: invite.id })} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" /> Revoke invite
            </button>
          ) : null}
          {deletion.canDelete ? (
            <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.requestDeleteInvite({ email: invite.email, id: invite.id })} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" /> Delete invite
            </button>
          ) : null}
          {!deletion.canDelete ? <p className="border-l border-trace-strong pl-3 text-xs leading-5 text-ink-muted">{deletion.summary}</p> : null}
        </div>
      </section>
    </article>
  );
}

export function AdminInvitesSection(props: AdminInvitesSectionProps) {
  const { actions, data, state, status } = props;
  return (
    <AdminTaskWorkspace indexWidth="22rem">
      <AdminTaskIndexPane compactDetailOpen={state.compactDetailOpen} testId="admin-invites-index">
        <div className="border-b border-trace-subtle p-3">
          <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-invites-search">Search invites</label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              className={`${inputClass} pl-9`}
              id="admin-invites-search"
              onChange={(event) => actions.changeQuery(event.currentTarget.value)}
              placeholder="Email or default group"
              value={state.query}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Invite status filters">
            {(["all", "open", "soon", "accepted", "revoked", "expired"] as const).map((filter) => (
              <button
                aria-pressed={state.statusFilter === filter}
                className={state.statusFilter === filter ? primaryButton : quietButton}
                key={filter}
                onClick={() => actions.changeStatusFilter(filter)}
                type="button"
              >
                <span>{inviteFilterLabels[filter]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="border-b border-trace-subtle px-4 py-2 text-xs leading-5 text-ink-muted">
          Only a freshly-created invite exposes its one-time link.
        </div>
        <div className="min-w-0 divide-y divide-trace-subtle" data-testid="admin-invites-list">
          {data.invites.length ? data.invites.map((invite) => {
            const currentStatus = inviteStatus(invite, data.nowMs);
            return (
              <article className={`min-w-0 px-4 py-3 ${data.selectedInvite?.id === invite.id ? "bg-control-selected" : "bg-transparent"}`} data-testid="admin-invite-row" key={invite.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{invite.email}</p>
                    <p className="mt-1 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{groupLabel(invite.defaultGroups)}</p>
                  </div>
                  <span className={`shrink-0 rounded-pill border px-2 py-0.5 text-[11px] capitalize ${inviteStatusClass(currentStatus)}`}>
                    {inviteStatusLabel(currentStatus)}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-ink-muted">
                    {invite.acceptedAt ? `Accepted ${formatDate(invite.acceptedAt)}` : invite.revokedAt ? `Revoked ${formatDate(invite.revokedAt)}` : `Expires ${formatDate(invite.expiresAt)}`}
                  </p>
                  <button className={quietButton} onClick={() => actions.selectInvite(invite.id)} type="button">Details</button>
                </div>
              </article>
            );
          }) : (
            <EmptyState
              detail={data.totalInviteCount ? "Change the search or lifecycle filter to see other invites." : "Create an invite to onboard one person."}
              title={data.totalInviteCount ? "No invites match this view" : "No invites"}
            />
          )}
        </div>
      </AdminTaskIndexPane>

      <AdminTaskDetailPane compactDetailOpen={state.compactDetailOpen} testId="admin-invites-detail-pane">
        {state.formOpen ? <InviteCreateTask {...props} /> : <InviteDetail actions={actions} invite={data.selectedInvite} nowMs={data.nowMs} status={status} />}
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}
