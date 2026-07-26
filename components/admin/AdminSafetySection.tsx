import { dangerButton } from "@/components/admin/adminPrimitives";
import { RotateCcw } from "lucide-react";

export type AdminSafetySectionProps = Readonly<{
  actionsDisabled: boolean;
  currentAdminEmail: string;
  lastRefreshedText: string;
  onRequestRevokeAllSessions(): void;
}>;

export function AdminSafetySection({
  actionsDisabled,
  currentAdminEmail,
  lastRefreshedText,
  onRequestRevokeAllSessions
}: AdminSafetySectionProps) {
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <section className="max-w-3xl border-t border-critical pt-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-critical">
          Installation-wide action
        </p>
        <h3 className="mt-2 text-lg font-semibold tracking-tight text-ink">Global session reset</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">
          This revokes every active session, including yours. User-specific session revocation stays with the relevant
          account in Users.
        </p>

        <dl className="mt-6 border-y border-trace-subtle text-sm">
          <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-ink-muted">Scope</dt>
            <dd className="break-words text-ink [overflow-wrap:anywhere]">Every active AIQSA session</dd>
          </div>
          <div className="grid min-w-0 gap-1 border-t border-trace-subtle py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-ink-muted">Includes</dt>
            <dd className="break-words text-ink [overflow-wrap:anywhere]">Your current administrator session</dd>
          </div>
          <div className="grid min-w-0 gap-1 border-t border-trace-subtle py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
            <dt className="font-medium text-ink-muted">After reset</dt>
            <dd className="break-words text-ink [overflow-wrap:anywhere]">Everyone must sign in again</dd>
          </div>
        </dl>

        <div className="mt-5 flex min-w-0 flex-col items-start gap-2">
          <button
            className={dangerButton}
            disabled={actionsDisabled}
            onClick={onRequestRevokeAllSessions}
            type="button"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Revoke all sessions
          </button>
          <p className="text-xs leading-5 text-ink-muted">
            {actionsDisabled
              ? "Unavailable while another administrator action finishes."
              : "A final confirmation names the consequence before this runs."}
          </p>
        </div>
      </section>

      <aside className="mt-10 max-w-3xl border-t border-trace-subtle pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Current admin</p>
        <div className="mt-2 grid min-w-0 gap-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
          <p className="break-words font-medium text-ink [overflow-wrap:anywhere]">{currentAdminEmail}</p>
          <p className="text-xs text-ink-muted">Last refreshed {lastRefreshedText}</p>
        </div>
        <p className="mt-3 max-w-2xl text-xs leading-5 text-ink-secondary">
          High-risk session control is isolated here. Routine refresh and account-level session actions remain in their
          owning workflows.
        </p>
      </aside>
    </div>
  );
}
