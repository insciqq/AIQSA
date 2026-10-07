"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { healthCategoryLabels, healthStageLabel, healthTime } from "@/components/admin/health/healthFormat";
import type { AdminHealthIncidentsController } from "@/components/admin/health/useAdminHealth";
import {
  adminHealthEventCategory,
  adminHealthIncidentCategories,
  isAdminHealthReference,
  ADMIN_HEALTH_CODE_PATTERN,
  type AdminHealthIncident,
  type AdminHealthIncidentCategory
} from "@/lib/contracts/adminHealth";
import { useId, useState, type FormEvent } from "react";

export type AdminHealthIncidentFilterState = Readonly<{
  category: AdminHealthIncidentCategory | null;
  code: string | null;
  level: "error" | "fatal" | null;
  q: string | null;
}>;

export const emptyIncidentFilters: AdminHealthIncidentFilterState = { category: null, code: null, level: null, q: null };

const selectClass = `${inputClass.replace("w-full", "w-auto")} min-w-0 pr-8`;

function IncidentRow({ incident }: Readonly<{ incident: AdminHealthIncident }>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const category = adminHealthEventCategory(incident.event);
  const provider = [incident.connectionName, incident.modelName].filter(Boolean).join(" · ");
  const facts: [string, string][] = [
    ["Time", healthTime(incident.occurredAt)],
    ["Process", incident.role.replaceAll("_", " ")],
    ["Event", incident.event],
    ["Code", incident.code ?? "—"],
    ...(incident.subsystem ? [["Subsystem", incident.subsystem] as [string, string]] : []),
    ...(incident.stage ? [["Stage", healthStageLabel(incident.stage)] as [string, string]] : []),
    ...(incident.connectionName ? [["Connection", incident.connectionName] as [string, string]] : []),
    ...(incident.modelName ? [["Model", incident.modelName] as [string, string]] : []),
    ...(incident.httpStatus !== null ? [["HTTP status", String(incident.httpStatus)] as [string, string]] : []),
    ...(incident.runId ? [["Run id", incident.runId] as [string, string]] : []),
    ...(incident.traceId ? [["Trace id", incident.traceId] as [string, string]] : []),
    ...incident.details.map((detail) => [detail.key, String(detail.value)] as [string, string])
  ];
  return (
    <li className="min-w-0" data-testid="admin-health-incident">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="v2-focusable flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left hover:bg-control-hover"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span
          className={`mt-px inline-flex h-5 shrink-0 items-center rounded-pill border px-1.5 text-metadata font-semibold ${incident.level === "fatal"
            ? "border-critical/40 bg-critical/15 text-critical" : "border-critical/25 bg-critical/5 text-critical"}`}
        >
          {incident.level === "fatal" ? "Fatal" : "Error"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-mono text-xs font-medium text-ink [overflow-wrap:anywhere]">
            {incident.code ?? incident.event}
          </span>
          <span className="mt-0.5 block break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
            {healthCategoryLabels[category]}{provider ? ` · ${provider}` : ""}{incident.httpStatus !== null ? ` · HTTP ${incident.httpStatus}` : ""}
          </span>
        </span>
        <time className="shrink-0 text-xs text-ink-muted" dateTime={incident.occurredAt}>
          {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(incident.occurredAt))}
        </time>
      </button>
      {open ? (
        <dl className="grid min-w-0 grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 pb-3 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]" id={panelId}>
          {facts.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="break-words text-ink-muted [overflow-wrap:anywhere]">{label}</dt>
              <dd className="select-text break-words font-mono text-ink-secondary [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

/** Recent error incidents, newest first, with filters, run/trace lookup and paging. */
export function AdminHealthIncidents({
  controller,
  filters,
  onChangeFilters,
  retentionNote
}: Readonly<{
  controller: AdminHealthIncidentsController;
  filters: AdminHealthIncidentFilterState;
  onChangeFilters(next: AdminHealthIncidentFilterState): void;
  retentionNote: boolean;
}>) {
  const [codeDraft, setCodeDraft] = useState(filters.code ?? "");
  const [queryDraft, setQueryDraft] = useState(filters.q ?? "");
  const [fieldError, setFieldError] = useState<"code" | "q" | null>(null);
  const errorId = useId();
  const filtered = filters.category !== null || filters.code !== null || filters.level !== null || filters.q !== null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = codeDraft.trim();
    const q = queryDraft.trim();
    if (code && !ADMIN_HEALTH_CODE_PATTERN.test(code)) {
      setFieldError("code");
      return;
    }
    if (q && !isAdminHealthReference(q)) {
      setFieldError("q");
      return;
    }
    setFieldError(null);
    onChangeFilters({ ...filters, code: code || null, q: q || null });
  };

  const clear = () => {
    setCodeDraft("");
    setQueryDraft("");
    setFieldError(null);
    onChangeFilters(emptyIncidentFilters);
  };

  return (
    <div className="min-w-0" data-testid="admin-health-incidents">
      <form aria-label="Filter incidents" className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={submit} role="search">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-secondary">
          Area
          <select
            className={selectClass}
            onChange={(event) => onChangeFilters({ ...filters, category: (event.target.value || null) as AdminHealthIncidentCategory | null })}
            value={filters.category ?? ""}
          >
            <option value="">All areas</option>
            {adminHealthIncidentCategories.map((category) => (
              <option key={category} value={category}>{healthCategoryLabels[category]}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-secondary">
          Level
          <select
            className={selectClass}
            onChange={(event) => onChangeFilters({ ...filters, level: (event.target.value || null) as "error" | "fatal" | null })}
            value={filters.level ?? ""}
          >
            <option value="">Any level</option>
            <option value="error">Error</option>
            <option value="fatal">Fatal</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-[1_1_9rem] flex-col gap-1 text-xs font-medium text-ink-secondary">
          Code
          <input
            aria-describedby={fieldError === "code" ? errorId : undefined}
            aria-invalid={fieldError === "code" || undefined}
            autoComplete="off"
            className={inputClass}
            maxLength={128}
            onChange={(event) => setCodeDraft(event.target.value)}
            placeholder="provider_auth_rejected"
            spellCheck={false}
            value={codeDraft}
          />
        </label>
        <label className="flex min-w-0 flex-[2_1_12rem] flex-col gap-1 text-xs font-medium text-ink-secondary">
          Run or trace id
          <input
            aria-describedby={fieldError === "q" ? errorId : undefined}
            aria-invalid={fieldError === "q" || undefined}
            autoComplete="off"
            className={inputClass}
            maxLength={128}
            onChange={(event) => setQueryDraft(event.target.value)}
            placeholder="Exact id"
            spellCheck={false}
            type="search"
            value={queryDraft}
          />
        </label>
        <button className="v2-button v2-focusable" data-tone="ghost" type="submit"><span>Search</span></button>
        {filtered ? (
          <button className="v2-button v2-focusable" data-tone="ghost" onClick={clear} type="button"><span>Clear</span></button>
        ) : null}
      </form>
      {fieldError ? (
        <p className="mt-1.5 text-xs text-critical" id={errorId} role="alert">
          {fieldError === "q" ? "Enter an exact run id or a 32-character trace id." : "Codes use letters, digits, dots, dashes and underscores."}
        </p>
      ) : null}
      {retentionNote ? <p className="mt-2 text-xs text-ink-muted">Incidents are kept for 14 days.</p> : null}

      <div className="mt-3 min-w-0 overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        {controller.loading && controller.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted" role="status">Loading incidents…</p>
        ) : controller.error ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-4" role="alert">
            <p className="text-sm text-ink">
              {controller.error === "invalid" ? "These filters could not be applied." : "Incidents could not be loaded."}
            </p>
            {controller.error === "invalid" ? (
              <button className="v2-button v2-focusable" data-tone="ghost" onClick={clear} type="button"><span>Clear filters</span></button>
            ) : (
              <button className="v2-button v2-focusable" data-tone="ghost" onClick={controller.refresh} type="button"><span>Try again</span></button>
            )}
          </div>
        ) : controller.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted" data-testid="admin-health-incidents-empty" role="status">
            {filtered ? "No incidents match these filters." : "No incidents in this period."}
          </p>
        ) : (
          <ul aria-busy={controller.loading || undefined} aria-label="Incidents" className="divide-y divide-trace-subtle">
            {controller.items.map((incident) => <IncidentRow incident={incident} key={incident.id} />)}
          </ul>
        )}
      </div>
      {controller.items.length > 0 && (controller.hasMore || controller.moreError) ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            aria-busy={controller.loadingMore || undefined}
            className="v2-button v2-focusable"
            data-tone="ghost"
            disabled={controller.loadingMore}
            onClick={controller.loadMore}
            type="button"
          >
            <span>{controller.moreError ? "Try loading more again" : "Load more"}</span>
          </button>
          {controller.moreError ? <p className="text-xs text-critical" role="alert">More incidents could not be loaded.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
