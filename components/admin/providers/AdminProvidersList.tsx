"use client";

import { adminSectionPath, type AdminSectionId } from "@/components/admin/adminSections";
import {
  providerListStatus,
  providerModelsSummary,
  providerSubtitle,
  visibleUsageTags,
  type ProviderUsageIndex
} from "@/components/admin/providers/providerListView";
import {
  ProviderAvatar,
  ProviderStatusPill,
  ProviderTag
} from "@/components/admin/providers/providerPrimitives";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import type { MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

/** One set of tracks for the header and every row (PRD 5.2). */
const gridTracks =
  "md:grid-cols-[2rem_minmax(0,1fr)_4.5rem_8.5rem_15rem_8rem_1rem] lg:grid-cols-[2rem_minmax(0,1fr)_4.5rem_9.5rem_16.25rem_8.5rem_1rem]";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export type AdminProvidersListProps = Readonly<{
  connections: readonly AdminProviderConnection[];
  error: string | null;
  loaded: boolean;
  loading: boolean;
  onNavigateSection(section: AdminSectionId): void;
  onOpen(connectionId: string): void;
  onRetry(): void;
  usage: ProviderUsageIndex;
}>;

export function AdminProvidersList({
  connections,
  error,
  loaded,
  loading,
  onNavigateSection,
  onOpen,
  onRetry,
  usage
}: AdminProvidersListProps) {
  if (loading && !loaded) {
    return (
      <p className="px-4 py-12 text-center text-sm text-ink-muted sm:px-6" role="status">
        Loading providers…
      </p>
    );
  }
  if (loaded && error && connections.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
        <p className="min-w-0 flex-1 text-sm text-ink">Providers could not be loaded. {error}</p>
        <UiV2Button onClick={onRetry} tone="ghost" type="button">Try again</UiV2Button>
      </div>
    );
  }

  const sectionLink = (section: AdminSectionId, label: string) => (
    <a
      className={`font-medium text-proof hover:underline ${focusRing}`}
      href={adminSectionPath(currentHref(), section)}
      onClick={(event) => {
        if (!primaryClick(event)) return;
        event.preventDefault();
        onNavigateSection(section);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="flex flex-col gap-4">
      {connections.length === 0 ? (
        <div className="rounded-[12px] border border-trace-subtle bg-answer-paper px-5 py-10 text-center" role="status">
          <p className="text-sm font-semibold text-ink-secondary">No providers yet</p>
          <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">
            Add a provider to connect a key and choose the models people can use.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
          <div
            aria-hidden="true"
            className={`hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted md:grid ${gridTracks}`}
          >
            <span />
            <span>Provider</span>
            <span>Keys</span>
            <span>Models</span>
            <span>Used as</span>
            <span>Status</span>
            <span />
          </div>
          <ul aria-label="Providers" className="divide-y divide-trace-subtle">
            {connections.map((connection) => {
              const status = providerListStatus(connection);
              const tags = visibleUsageTags(usage.get(connection.id) ?? []);
              const subtitle = providerSubtitle(connection, usage);
              const keys = connection.credentials.length;
              const models = providerModelsSummary(connection);
              return (
                <li key={connection.id}>
                  <a
                    aria-label={`Open ${connection.displayName} · ${status.label}`}
                    className={[
                      "grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 px-4 py-3 hover:bg-control-hover sm:px-5 md:gap-x-4",
                      gridTracks,
                      focusRing,
                      connection.enabled ? "" : "opacity-65"
                    ].join(" ")}
                    data-provider-status={status.kind}
                    data-testid={`provider-row-${connection.id}`}
                    href={adminSectionPath(currentHref(), "providers", connection.id)}
                    onClick={(event) => {
                      if (!primaryClick(event)) return;
                      event.preventDefault();
                      onOpen(connection.id);
                    }}
                  >
                    <ProviderAvatar family={connection.family} label={connection.displayName} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{connection.displayName}</span>
                      <span className="block truncate text-xs text-ink-muted">{subtitle}</span>
                      <span className="mt-0.5 block truncate text-xs text-ink-muted md:hidden">
                        {keys} {keys === 1 ? "key" : "keys"} · {models}
                        {tags.shown.length ? ` · ${tags.shown.join(", ")}${tags.hidden ? ` +${tags.hidden}` : ""}` : ""}
                      </span>
                    </span>
                    <span className="hidden whitespace-nowrap text-sm text-ink-secondary md:block">{keys}</span>
                    <span className="hidden whitespace-nowrap text-sm text-ink-secondary md:block">{models}</span>
                    <span className="hidden min-w-0 items-center gap-1 overflow-hidden md:flex">
                      {tags.shown.map((tag) => (
                        <ProviderTag accent={tag === "Default chat"} key={tag}>{tag}</ProviderTag>
                      ))}
                      {tags.hidden ? <ProviderTag>+{tags.hidden}</ProviderTag> : null}
                    </span>
                    <span className="justify-self-start">
                      <ProviderStatusPill label={status.label} tone={status.tone} />
                    </span>
                    <UiV2Icon className="text-ink-muted" name="chevron-right" />
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-xs leading-5 text-ink-muted">
        Who can use which model is set per group in {sectionLink("groups", "Groups")}. The default chat
        model and internal roles are set in {sectionLink("roles", "Defaults & roles")}.
      </p>
    </div>
  );
}
