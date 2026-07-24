import { quietButton } from "@/components/admin/adminPrimitives";
import { formatTime } from "@/components/admin/adminViewUtils";
import { ArrowLeft, Clock, RefreshCw, Shield } from "lucide-react";
import Link from "next/link";

export type AdminConsoleHeaderProps = Readonly<{
  adminEmail: string;
  lastLoadedAt: Date | null;
  loading: boolean;
  onRefresh(): void;
  submitting: boolean;
}>;

export function AdminConsoleHeader({
  adminEmail,
  lastLoadedAt,
  loading,
  onRefresh,
  submitting
}: AdminConsoleHeaderProps) {
  return (
    <header className="flex flex-col gap-4 rounded-panel bg-surface-navigation/90 px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-accent-cyan">
          <Shield className="size-4" aria-hidden="true" />
          <span className="text-xs font-medium text-accent-cyan">Admin console</span>
        </div>
        <h1 className="text-xl font-semibold text-content-primary">Operations control</h1>
        <p className="mt-1 break-words text-sm text-content-muted [overflow-wrap:anywhere]">Signed in as {adminEmail}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link className={quietButton} href="/">
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Return to workspace
        </Link>
        <span
          aria-live="polite"
          className="inline-flex min-h-control-sm items-center gap-1.5 rounded-control bg-surface-raised px-3 text-xs text-content-secondary"
          role="status"
        >
          <Clock className="size-3.5" aria-hidden="true" />
          {loading
            ? "Refreshing admin data…"
            : submitting
              ? "Saving admin changes…"
              : `Last refresh ${formatTime(lastLoadedAt)}`}
        </span>
        <button
          aria-label="Refresh admin overview"
          className={quietButton}
          disabled={loading}
          onClick={() => onRefresh()}
          type="button"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </header>
  );
}
