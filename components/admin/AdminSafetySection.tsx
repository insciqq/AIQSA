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
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-control border border-accent-rose/25 bg-accent-rose/10 px-3 py-3">
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-control border border-accent-rose/35 bg-accent-rose/10 text-accent-rose">
            <RotateCcw className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-content-primary">Global session reset</h3>
            <p className="mt-1 text-xs leading-5 text-content-secondary">
              Revokes every active session, including yours. User-specific session revocation stays scoped to each row
              in Users.
            </p>
            <button
              className={`${dangerButton} mt-3`}
              disabled={actionsDisabled}
              onClick={onRequestRevokeAllSessions}
              type="button"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Revoke all sessions
            </button>
          </div>
        </div>
      </section>

      <aside className="rounded-panel bg-surface-raised/50 px-3 py-3">
        <div className="text-xs font-medium text-content-secondary">Current admin</div>
        <div className="mt-2 break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">{currentAdminEmail}</div>
        <div className="mt-1 text-xs text-content-muted">Last refreshed {lastRefreshedText}</div>
        <div className="mt-3 rounded-control bg-surface-raised px-3 py-2 text-xs text-content-secondary">
          High-risk actions are isolated here so routine refresh and review actions stay visually quiet.
        </div>
      </aside>
    </div>
  );
}
