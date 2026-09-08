"use client";

import { inputClass, touchTarget } from "@/components/admin/adminPrimitives";
import { adminSectionPath } from "@/components/admin/adminSections";
import { sourceDisplay } from "@/components/admin/mcp/adminMcpDraft";
import { McpServerTile, McpStatusPill } from "@/components/admin/mcp/mcpPrimitives";
import { mcpAccessSummary, mcpServerStatus, mcpToolsSummary } from "@/components/admin/mcp/mcpServerView";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { adminMcpAttention, type AdminMcpServer } from "@/lib/contracts/mcp";
import { CircleAlert, Search } from "lucide-react";
import { useId, useMemo, useState, type MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const attentionLink =
  `inline-flex min-h-control-sm items-center rounded-control px-2 text-xs font-medium text-caution hover:bg-caution/10 ${focusRing} ${touchTarget}`;

/** One set of tracks for the header and every row; the grid stacks below `xl`. */
const gridTracks = "xl:grid-cols-[2rem_minmax(12rem,1fr)_7rem_8rem_8rem_1rem]";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export type AdminMcpListProps = Readonly<{
  error: string | null;
  loaded: boolean;
  loading: boolean;
  onOpen(serverId: string): void;
  onRetry(): void;
  servers: readonly AdminMcpServer[];
}>;

function ServerRow({ onOpen, server }: Readonly<{ onOpen(serverId: string): void; server: AdminMcpServer }>) {
  const status = mcpServerStatus(server);
  const attention = adminMcpAttention(server);
  const tools = mcpToolsSummary(server);
  const access = mcpAccessSummary(server);
  return (
    <li
      className={[
        "relative grid grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 px-4 py-3 hover:bg-control-hover sm:px-5 xl:min-h-14 xl:gap-x-4 xl:py-2.5",
        gridTracks,
        status.kind === "disabled" || status.kind === "archived" ? "opacity-65" : ""
      ].join(" ")}
      data-mcp-status={status.kind}
      data-testid={`mcp-server-row-${server.id}`}
    >
      <McpServerTile label={server.name} />
      <div className="min-w-0">
        <a
          aria-label={`Open ${server.name} · ${status.label}`}
          className={`block truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] hover:text-proof ${focusRing}`}
          href={adminSectionPath(currentHref(), "mcp", server.id)}
          onClick={(event) => {
            if (!primaryClick(event)) return;
            event.preventDefault();
            onOpen(server.id);
          }}
        >
          {server.name}
        </a>
        <p className="truncate text-xs text-ink-muted">{server.description || sourceDisplay(server.draft.source)}</p>
        <p className="mt-0.5 truncate text-xs text-ink-muted xl:hidden">{tools} · {access}</p>
        {attention ? (
          <span className="relative z-[1] mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-caution">
            <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0">{attention.label}</span>
            {attention.href ? (
              <a aria-label={`${attention.action} ${server.name}`} className={attentionLink} href={attention.href}>
                {attention.action}
              </a>
            ) : null}
          </span>
        ) : null}
      </div>
      <span className="hidden truncate text-sm text-ink-secondary xl:block">{tools}</span>
      <span className="hidden truncate text-sm text-ink-secondary xl:block">{access}</span>
      <span className="justify-self-start">
        <McpStatusPill label={status.label} tone={status.tone} />
      </span>
      <UiV2Icon className="text-ink-muted" name="chevron-right" />
    </li>
  );
}

/** The server list (PRD 5.10): tile, name and source, tools, access, one status word, chevron. */
export function AdminMcpList({
  error,
  loaded,
  loading,
  onOpen,
  onRetry,
  servers
}: AdminMcpListProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return servers;
    return servers.filter((server) =>
      [server.name, server.description, sourceDisplay(server.draft.source)]
        .some((value) => value.toLowerCase().includes(normalized)));
  }, [query, servers]);

  if (loading && !loaded) {
    return (
      <p className="px-4 py-12 text-center text-sm text-ink-muted sm:px-6" role="status">
        Loading MCP servers…
      </p>
    );
  }
  if (loaded && error && servers.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
        <p className="min-w-0 flex-1 text-sm text-ink">MCP servers could not be loaded. {error}</p>
        <UiV2Button onClick={onRetry} tone="ghost" type="button">Try again</UiV2Button>
      </div>
    );
  }
  if (servers.length === 0) {
    return (
      <div className="rounded-[12px] border border-trace-subtle bg-answer-paper px-5 py-10 text-center" role="status">
        <p className="text-sm font-semibold text-ink-secondary">No MCP servers yet</p>
        <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">
          New server adds one from a pasted URL, JSON entry or install command, checks it and makes its tools available to the groups and users you choose.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative w-full sm:w-80">
        <label className="sr-only" htmlFor={searchId}>Search servers</label>
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
        <input
          className={`${inputClass} h-8 min-h-0 py-0 pl-9 text-[13px]`}
          id={searchId}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, source or description"
          type="search"
          value={query}
        />
      </div>
      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper" data-testid="mcp-server-list">
        {visible.length ? (
          <>
            <div
              aria-hidden="true"
              className={`hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted xl:grid ${gridTracks}`}
            >
              <span />
              <span>Server</span>
              <span>Tools</span>
              <span>Access</span>
              <span>Status</span>
              <span />
            </div>
            <ul aria-label="MCP servers" className="divide-y divide-trace-subtle">
              {visible.map((server) => <ServerRow key={server.id} onOpen={onOpen} server={server} />)}
            </ul>
          </>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-ink-muted" role="status">No servers match this search.</p>
        )}
      </div>
    </div>
  );
}
