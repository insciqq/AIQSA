import { quietButton } from "@/components/admin/adminPrimitives";
import { formatTime } from "@/components/admin/adminViewUtils";
import { ArrowLeft, Clock, RefreshCw } from "lucide-react";
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
    <header className="flex min-w-0 flex-col gap-3 border-b border-trace-subtle bg-answer-paper px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-5 sm:[@media(max-height:32rem)]:!flex-row sm:[@media(max-height:32rem)]:!items-center sm:[@media(max-height:32rem)]:!justify-between sm:[@media(max-height:32rem)]:!gap-3 sm:[@media(max-height:32rem)]:!py-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:[@media(max-height:32rem)]:!text-base">
          Control Center
        </h1>
        <p className="mt-1 break-words text-sm text-ink-muted [overflow-wrap:anywhere] sm:[@media(max-height:32rem)]:!mt-0 sm:[@media(max-height:32rem)]:!text-xs">
          {adminEmail}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:[@media(max-height:32rem)]:!flex-nowrap sm:[@media(max-height:32rem)]:!gap-1">
        <Link className={quietButton} href="/">
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Return to chat
        </Link>
        <span
          aria-live="polite"
          className="inline-flex min-h-control-sm items-center gap-1.5 px-2 text-xs text-ink-muted"
          role="status"
        >
          <Clock className="size-3.5" aria-hidden="true" />
          {loading
            ? "Refreshing…"
            : submitting
              ? "Saving changes…"
              : `Updated ${formatTime(lastLoadedAt)}`}
        </span>
        <button
          aria-label="Refresh Control Center"
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
