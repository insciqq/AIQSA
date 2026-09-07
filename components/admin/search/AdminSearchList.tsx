"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import { SearchSourceTile, SearchStatusPill } from "@/components/admin/search/searchPrimitives";
import { searchModelsReach, searchSourceStatus } from "@/components/admin/search/searchSourceView";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import type { MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

/** One set of tracks for the header and every row; the grid stacks below `md`. */
const gridTracks = "md:grid-cols-[2rem_minmax(0,1fr)_11rem_9.5rem_1rem]";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export type AdminSearchListProps = Readonly<{
  error: string | null;
  loaded: boolean;
  loading: boolean;
  onOpen(sourceId: string): void;
  onRetry(): void;
  sources: readonly AdminSearchIntegration[];
}>;

/** The source list (PRD 5.6): tile, name and purpose, chat-model reach, one status word, chevron. */
export function AdminSearchList({
  error,
  loaded,
  loading,
  onOpen,
  onRetry,
  sources
}: AdminSearchListProps) {
  if (loading && !loaded) {
    return (
      <p className="px-4 py-12 text-center text-sm text-ink-muted sm:px-6" role="status">
        Loading Search sources…
      </p>
    );
  }
  if (loaded && error && sources.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
        <p className="min-w-0 flex-1 text-sm text-ink">Search sources could not be loaded. {error}</p>
        <UiV2Button onClick={onRetry} tone="ghost" type="button">Try again</UiV2Button>
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="rounded-[12px] border border-trace-subtle bg-answer-paper px-5 py-10 text-center" role="status">
        <p className="text-sm font-semibold text-ink-secondary">No Search sources yet</p>
        <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">
          Sources for built-in providers appear when the provider is added. Add source creates one from a Perplexity model.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
      <div
        aria-hidden="true"
        className={`hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted md:grid ${gridTracks}`}
      >
        <span />
        <span>Source</span>
        <span>Chat models</span>
        <span>Status</span>
        <span />
      </div>
      <ul aria-label="Search sources" className="divide-y divide-trace-subtle">
        {sources.map((source) => {
          const status = searchSourceStatus(source);
          const reach = searchModelsReach(source);
          return (
            <li key={source.id}>
              <a
                aria-label={`Open ${source.displayName} · ${status.label}`}
                className={[
                  "grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 px-4 py-3 hover:bg-control-hover sm:px-5 md:gap-x-4",
                  gridTracks,
                  focusRing,
                  status.kind === "disabled" || status.kind === "archived" ? "opacity-65" : ""
                ].join(" ")}
                data-search-status={status.kind}
                data-testid={`search-source-row-${source.id}`}
                href={adminSectionPath(currentHref(), "search", source.id)}
                onClick={(event) => {
                  if (!primaryClick(event)) return;
                  event.preventDefault();
                  onOpen(source.id);
                }}
              >
                <SearchSourceTile label={source.displayName} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{source.displayName}</span>
                  <span className="block truncate text-xs text-ink-muted">{source.description}</span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted md:hidden">{reach}</span>
                </span>
                <span className="hidden truncate text-sm text-ink-secondary md:block">{reach}</span>
                <span className="justify-self-start">
                  <SearchStatusPill label={status.label} tone={status.tone} />
                </span>
                <UiV2Icon className="text-ink-muted" name="chevron-right" />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
