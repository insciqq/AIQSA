/* eslint-disable @next/next/no-html-link-for-pages -- Control Center exits use a full-document navigation so native beforeunload protection owns document-level draft safety. */
import { quietButton } from "@/components/admin/adminPrimitives";
import { formatTime } from "@/components/admin/adminViewUtils";
import type { AdminReleaseStatus } from "@/lib/contracts/adminRelease";
import { ArrowLeft, ArrowUpCircle, Clock, ExternalLink, RefreshCw } from "lucide-react";
import type { MouseEvent } from "react";

export type AdminConsoleHeaderProps = Readonly<{
  adminEmail: string;
  lastLoadedAt: Date | null;
  loading: boolean;
  onReturnToChatClick?(event: MouseEvent<HTMLAnchorElement>): void;
  onRefresh(): void;
  releaseStatus?: AdminReleaseStatus | null;
  submitting: boolean;
}>;

function releasePublishedDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date)
    : null;
}

export function AdminConsoleHeader({
  adminEmail,
  lastLoadedAt,
  loading,
  onReturnToChatClick,
  onRefresh,
  releaseStatus,
  submitting
}: AdminConsoleHeaderProps) {
  return (
    <header className="flex min-w-0 flex-col gap-3 border-b border-trace-subtle bg-answer-paper px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8 lg:py-5 sm:[@media(max-height:32rem)]:!flex-row sm:[@media(max-height:32rem)]:!items-center sm:[@media(max-height:32rem)]:!justify-between sm:[@media(max-height:32rem)]:!gap-3 sm:[@media(max-height:32rem)]:!py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:[@media(max-height:32rem)]:!text-base">
            Control Center
          </h1>
          {releaseStatus ? (
            <span className="font-mono text-metadata text-ink-muted">v{releaseStatus.currentVersion}</span>
          ) : null}
          {releaseStatus?.state === "update_available" && releaseStatus.latestVersion && releaseStatus.releaseUrl ? (
            <details className="group/update relative max-sm:basis-full">
              <summary className="flex min-h-control-sm w-fit cursor-pointer list-none items-center gap-1.5 rounded-control border border-caution/30 bg-caution/[0.07] px-2 text-xs font-semibold text-caution outline-none marker:hidden hover:bg-caution/[0.12] focus-visible:ring-2 focus-visible:ring-caution/40">
                <ArrowUpCircle className="size-3.5" aria-hidden="true" />
                Update available · v{releaseStatus.latestVersion}
              </summary>
              <div
                className="absolute left-0 z-30 mt-2 w-[min(21rem,calc(100vw-2rem))] border border-trace-subtle bg-answer-paper p-3 text-xs leading-5 text-ink-secondary shadow-sm"
                data-testid="admin-release-update-details"
              >
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <span className="text-ink-muted">Installed</span>
                  <span className="font-mono text-ink">v{releaseStatus.currentVersion}</span>
                  <span className="text-ink-muted">Latest</span>
                  <span className="font-mono text-ink">v{releaseStatus.latestVersion}</span>
                  {releasePublishedDate(releaseStatus.publishedAt) ? (
                    <>
                      <span className="text-ink-muted">Published</span>
                      <span>{releasePublishedDate(releaseStatus.publishedAt)}</span>
                    </>
                  ) : null}
                </div>
                <a
                  className="mt-2 inline-flex min-h-control-sm items-center gap-1.5 font-medium text-proof hover:text-proof-hover hover:underline"
                  href={releaseStatus.releaseUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  View release notes
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </div>
            </details>
          ) : null}
        </div>
        <p className="mt-1 break-words text-sm text-ink-muted [overflow-wrap:anywhere] sm:[@media(max-height:32rem)]:!mt-0 sm:[@media(max-height:32rem)]:!text-xs">
          {adminEmail}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:[@media(max-height:32rem)]:!flex-nowrap sm:[@media(max-height:32rem)]:!gap-1">
        <a
          aria-disabled={submitting || undefined}
          className={`${quietButton} ${
            submitting
              ? "cursor-not-allowed bg-control-surface text-ink-disabled opacity-60 hover:bg-control-surface hover:text-ink-disabled active:bg-control-surface"
              : ""
          }`}
          href="/"
          onClick={(event) => {
            if (submitting) {
              event.preventDefault();
              return;
            }
            onReturnToChatClick?.(event);
          }}
          tabIndex={submitting ? -1 : undefined}
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Return to chat
        </a>
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
          aria-label="Refresh Control Center dashboard"
          className={quietButton}
          disabled={loading || submitting}
          onClick={() => onRefresh()}
          type="button"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh dashboard
        </button>
      </div>
    </header>
  );
}
