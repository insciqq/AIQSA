import {
  AdminGroupOptions,
  AdminTableRegion,
  dangerButton,
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
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
  totalInviteCount: number;
}>;

export type AdminInvitesSectionState = Readonly<{
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
  changeEmail(value: string): void;
  changeGroups(groupIds: string[]): void;
  changeQuery(value: string): void;
  changeSendEmail(value: boolean): void;
  changeStatusFilter(status: AdminInviteStatusFilter): void;
  copyOneTimeUrl(): Promise<void> | void;
  createInvite(): Promise<void> | void;
  requestDeleteInvite(invite: AdminInviteActionTarget): void;
  requestRevokeInvite(invite: AdminInviteActionTarget): void;
}>;

export type AdminInvitesSectionProps = Readonly<{
  actions: AdminInvitesSectionActions;
  data: AdminInvitesSectionData;
  state: AdminInvitesSectionState;
  status: AdminInvitesSectionStatus;
}>;

function inviteLinkDeliveryCopy(delivery: AdminInviteEmailDelivery | null): string {
  if (delivery === "sent") {
    return "The invitation email was sent. Copy this link now if you also want a manual fallback; it cannot be recovered later.";
  }

  if (delivery === "unavailable") {
    return "Email delivery is not configured. Copy and share this create-account link now; it cannot be recovered later.";
  }

  if (delivery === "failed") {
    return "The email could not be sent. Copy and share this create-account link now; it cannot be recovered later.";
  }

  if (delivery === "not_requested") {
    return "No invitation email was sent. Copy and share this create-account link now; it cannot be recovered later.";
  }

  return "Copy this create-account link now. Existing invite tokens are stored as hashes and cannot be recovered later.";
}

export function AdminInvitesSection({ actions, data, state, status }: AdminInvitesSectionProps) {
  return (
    <>
      {state.formOpen ? (
        <form
          className="grid gap-3 border-b border-separator-subtle bg-surface-raised/40 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.createInvite();
          }}
        >
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-content-secondary" htmlFor="invite-email">
              Email
            </label>
            <input
              aria-describedby={state.emailError ? "invite-email-error" : undefined}
              aria-invalid={state.emailError ? true : undefined}
              className={inputClass}
              id="invite-email"
              onChange={(event) => actions.changeEmail(event.currentTarget.value)}
              type="email"
              value={state.email}
            />
            {state.emailError ? (
              <p className="text-xs text-accent-rose" id="invite-email-error">
                {state.emailError}
              </p>
            ) : null}
          </div>
          <AdminGroupOptions
            groups={data.groups}
            label="Default groups"
            onChange={actions.changeGroups}
            selected={state.groupIds}
          />
          <label
            className={`flex min-h-control-sm max-w-xl items-start gap-2 rounded-control bg-surface-raised px-3 py-2 text-xs text-content-secondary ${touchTarget}`}
          >
            <input
              aria-label="Send invitation email"
              aria-describedby="invite-email-delivery-help"
              checked={state.sendEmail}
              className="mt-0.5 size-4 shrink-0 accent-accent-cyan"
              id="invite-send-email"
              onChange={(event) => actions.changeSendEmail(event.currentTarget.checked)}
              type="checkbox"
            />
            <span className="min-w-0">
              <span className="block font-medium text-content-primary">Send invitation email</span>
              <span className="mt-0.5 block leading-5 text-content-muted" id="invite-email-delivery-help">
                Uses configured SMTP. The fresh link will still appear below for manual copy.
              </span>
            </span>
          </label>
          <div>
            <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
              <Link2 className="size-3.5" aria-hidden="true" />
              Create invite
            </button>
          </div>
          {state.oneTimeUrl ? (
            <div className="rounded-control border border-accent-cyan/20 bg-accent-cyan/[0.07] px-3 py-2">
              <div className="text-xs font-medium text-content-secondary mb-1 text-accent-cyan">New invite link</div>
              <p className="mb-2 text-xs text-content-secondary">
                {inviteLinkDeliveryCopy(state.emailDelivery)}
              </p>
              <label className="block text-xs text-content-muted">
                Invite create-account link
                <div className="mt-1 flex gap-2">
                  <input
                    className={`min-h-control min-w-0 flex-1 rounded-control border border-separator-subtle bg-surface-thread px-2 font-mono text-xs text-content-primary ${focusRing} ${touchTarget}`}
                    readOnly
                    value={state.oneTimeUrl}
                  />
                  <button className={quietButton} type="button" onClick={() => void actions.copyOneTimeUrl()}>
                    <Copy className="size-3.5" aria-hidden="true" />
                    {state.oneTimeUrlCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              </label>
            </div>
          ) : null}
        </form>
      ) : null}

      <div className="flex flex-col gap-2 border-b border-separator-subtle bg-surface-raised/40 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-control-sm min-w-0 flex-1 items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 focus-within:ring-2 focus-within:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch">
          <Search className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
          <input
            aria-label="Search invites"
            className="min-h-control-sm min-w-0 flex-1 bg-transparent text-xs [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch text-content-primary outline-none placeholder:text-content-disabled"
            onChange={(event) => actions.changeQuery(event.currentTarget.value)}
            placeholder="Search invite emails or groups"
            value={state.query}
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Invite status filters">
          {(["all", "open", "soon", "accepted", "revoked", "expired"] as const).map((inviteStatusFilter) => (
            <button
              aria-pressed={state.statusFilter === inviteStatusFilter}
              className={[
                "inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch",
                state.statusFilter === inviteStatusFilter
                  ? "bg-surface-selected text-accent-cyan"
                  : "bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary"
              ].join(" ")}
              key={inviteStatusFilter}
              type="button"
              onClick={() => actions.changeStatusFilter(inviteStatusFilter)}
            >
              {inviteStatusFilter}
            </button>
          ))}
        </div>
      </div>

      <div className="border-b border-separator-subtle px-3 py-2 text-xs text-content-muted">
        Existing invites show status and default groups. Only the freshly-created invite link can be copied from this
        page.
      </div>

      <AdminTableRegion label="Invites table">
        <table className="w-full min-w-[820px] border-collapse text-left text-xs">
          <thead className="bg-surface-thread text-content-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Invite</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Default groups</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.invites.length ? (
              data.invites.map((invite) => {
                const currentStatus = inviteStatus(invite, data.nowMs);
                const deletion = inviteDeletionInfo(invite, data.nowMs);

                return (
                  <tr className="border-b border-separator-subtle align-top last:border-b-0" key={invite.id}>
                    <td className="px-3 py-3">
                      <div className="break-words text-content-primary [overflow-wrap:anywhere]">{invite.email}</div>
                      <div className="mt-1 text-content-muted">
                        {invite.acceptedAt
                          ? `Accepted ${formatDate(invite.acceptedAt)}`
                          : invite.revokedAt
                            ? `Revoked ${formatDate(invite.revokedAt)}`
                            : `Expires ${formatDate(invite.expiresAt)}`}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex rounded-pill border px-2 py-1 capitalize ${inviteStatusClass(currentStatus)}`}
                      >
                        {inviteStatusLabel(currentStatus)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-content-secondary">{groupLabel(invite.defaultGroups)}</td>
                    <td className="px-3 py-3">
                      <div className="flex max-w-[260px] flex-wrap gap-2">
                        {isInviteOpen(invite, data.nowMs) ? (
                          <button
                            className={dangerButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.requestRevokeInvite({ email: invite.email, id: invite.id })}
                            type="button"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            Revoke
                          </button>
                        ) : null}
                        {deletion.canDelete ? (
                          <button
                            className={dangerButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.requestDeleteInvite({ email: invite.email, id: invite.id })}
                            type="button"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            Delete
                          </button>
                        ) : null}
                        {!deletion.canDelete && (invite.acceptedAt || invite.revokedAt) ? (
                          <span className="text-content-muted">{deletion.summary}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="px-3 py-8 text-center text-content-muted" colSpan={4}>
                  {data.totalInviteCount ? "No invites match this view" : "No invites"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </AdminTableRegion>
    </>
  );
}
