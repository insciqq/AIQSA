"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { cardClass, sectionHeadingClass } from "./roles/rolesControls";
import { adminWorkspaceErrorMessage, getAdminWorkspaceOverview } from "./adminWorkspaceApi";
import type { WorkspaceOverviewFilter, WorkspaceOverviewState, WorkspaceOverviewWire } from "@/lib/contracts/workspaceOverview";

const statusLabels: Record<WorkspaceOverviewState, string> = {
  changing: "Changing", not_started: "Not started", paused: "Paused", ready: "Ready",
  running: "Working", starting: "Starting", stopped: "Stopped", stopping: "Stopping", unknown: "Unknown"
};

function observedTime(value: string) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function AdminWorkspaceOverview() {
  const [filter, setFilter] = useState<WorkspaceOverviewFilter>("active");
  const [page, setPage] = useState(1);
  const query = `${filter}:${page}`;
  const [result, setResult] = useState<{ query: string; value: WorkspaceOverviewWire } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);
  const overview = result?.query === query ? result.value : null;

  useEffect(() => {
    let disposed = false;
    let pending: AbortController | null = null;
    let lastStartedAt = -Infinity;
    async function refresh(force = false) {
      if (disposed || pending || document.visibilityState === "hidden" || !force && Date.now() - lastStartedAt < 5_000) return;
      const controller = new AbortController();
      pending = controller;
      lastStartedAt = Date.now();
      setBusy(true);
      const response = await getAdminWorkspaceOverview({
        filter, page, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      });
      if (disposed || controller.signal.aborted || pending !== controller) return;
      pending = null;
      setBusy(false);
      if (response.ok) {
        setResult({ query, value: response.data });
        setError(null);
      } else {
        // Losing administrator authority also removes previously visible rows.
        if (response.error === "forbidden" || response.error === "unauthorized") setResult(null);
        setError(adminWorkspaceErrorMessage(response.error));
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        pending?.abort();
        pending = null;
        setBusy(false);
      } else void refresh();
    };
    const onFocus = () => { void refresh(); };
    refreshRef.current = () => { void refresh(true); };
    void refresh(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      disposed = true;
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [filter, page, query]);

  const selectFilter = useCallback((value: WorkspaceOverviewFilter) => {
    setPage(1);
    setFilter(value);
    setError(null);
  }, []);
  const stale = Boolean(overview && (overview.state === "stale" || error));
  const pages = overview ? Math.max(1, Math.ceil(overview.totalCount / overview.pageSize)) : 1;

  return (
    <section aria-label="Workspace activity" className={`${cardClass} min-w-0 p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className={sectionHeadingClass}>Environments</h2>
        <UiV2Button busy={busy} onClick={() => refreshRef.current()} tone="ghost">
          Refresh activity
        </UiV2Button>
      </div>
      {error ? <p className="mt-3 text-xs leading-5 text-critical" role="alert">{error}</p> : null}
      {overview ? (
        <>
          <p className="mt-3 text-sm font-medium text-ink" aria-live="polite">
            {overview.activeCount === null ? "Live environment count is unknown."
              : `${overview.activeCount} ${stale ? "last known active" : "active"} ${overview.activeCount === 1 ? "environment" : "environments"}`}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {overview.transitioningCount} changing · {overview.unknownCount} unknown
            {overview.stoppedCount !== null ? ` · ${overview.stoppedCount} stopped` : ""}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {overview.observedAt ? <>Last observed {observedTime(overview.observedAt)}.</> : <>Checked {observedTime(overview.updatedAt)}.</>}
            {stale ? " Activity is stale; it could not be refreshed." : overview.state === "unavailable" ? " Activity could not be refreshed." : ""}
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Each chat has its own environment. Active includes idle, paused, and stopping environments while they remain live.
          </p>
        </>
      ) : !error ? <p className="mt-3 text-sm text-ink-muted" role="status">Loading Workspace activity…</p> : null}
      <div className="mt-4 flex flex-wrap gap-2" aria-label="Environment filter">
        <UiV2Button aria-pressed={filter === "active"} onClick={() => selectFilter("active")} tone="ghost">Active and unknown</UiV2Button>
        <UiV2Button aria-pressed={filter === "all"} onClick={() => selectFilter("all")} tone="ghost">All environments</UiV2Button>
      </div>
      {overview && overview.rows.length > 0 ? (
        <ul aria-label="Workspace environments" className="mt-3 divide-y divide-trace-subtle">
          {overview.rows.map((row) => (
            <li className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" key={row.id}>
              <div className="min-w-0">
                <p className="break-words text-sm text-ink [overflow-wrap:anywhere]">
                  {row.context === "project" ? "Created by " : ""}{row.user ?? (row.context ? "Deleted user" : "Unassigned environment")}
                </p>
                <p className="mt-1 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
                  {row.context === "project" ? "Project" : row.context === "personal" ? "Personal" : "Owner unavailable"}
                  {" · "}<span className="font-mono">{row.id}</span>
                </p>
              </div>
              <div className="min-w-0 sm:text-right">
                <p className={`text-xs font-medium ${row.state === "unknown" ? "text-caution" : "text-ink-secondary"}`}>
                  {stale ? "Last seen: " : ""}{statusLabels[row.state]}
                </p>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  {row.lastActiveAt ? <>Last activity {observedTime(row.lastActiveAt)}</> : "Last activity unavailable"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : overview?.state === "fresh" && !error ? (
        <p className="mt-4 text-sm text-ink-muted">{filter === "active" ? "No active environments." : "No environments yet."}</p>
      ) : null}
      {overview && pages > 1 ? (
        <nav aria-label="Environment pages" className="mt-4 flex flex-wrap items-center gap-3">
          <UiV2Button disabled={busy || overview.page <= 1} onClick={() => setPage(overview.page - 1)} tone="ghost">Previous environments</UiV2Button>
          <span className="text-xs text-ink-muted">Page {overview.page} of {pages} · {overview.totalCount} environments</span>
          <UiV2Button disabled={busy || overview.page >= pages} onClick={() => setPage(overview.page + 1)} tone="ghost">Next environments</UiV2Button>
        </nav>
      ) : null}
    </section>
  );
}
