import type { AdminAttentionItem } from "../../../contracts/adminAttention";
import {
  adminHealthCategories,
  adminHealthFailureClasses,
  adminHealthRanges,
  defaultAdminHealthRange,
  isAdminHealthRange,
  type AdminHealthCategory,
  type AdminHealthIncident,
  type AdminHealthIncidentFilters,
  type AdminHealthProviderRow,
  type AdminHealthRange,
  type AdminHealthRoleStarts,
  type AdminHealthSummary
} from "../../../contracts/adminHealth";
import { adminHealthQueueCopy, type AdminHealthQueueRow } from "../../../contracts/adminHealthQueues";
import type { AdminHealthRunSummary } from "../../../contracts/adminHealthRunLookup";
import { normalizeRunReference, runReferenceLabel } from "../../../contracts/runReference";
import { healthAttentionItems, type HealthFinding } from "../attention/healthRules";
import { queueAgeCopy, queueAttentionItems } from "../attention/queueRules";
import { adminHealthQueueFindings, type AdminHealthQueuesService } from "./queues";
import type { AdminHealthRunLookup } from "./runLookup";
import type { AdminHealthService } from "./service";

/**
 * The operator's command-line health report (`./aiqsa.sh health`): the same
 * content-free projections the Control Center Health page and its "Needs
 * attention" rules serve, condensed to what went wrong. It only reads.
 *
 * `--json` prints `HealthReport` or `HealthRunReport`; fields are added, never
 * renamed or removed, without bumping `version`.
 */
export const HEALTH_REPORT_VERSION = 1;
/** Incidents listed in a report; the Health page pages through the rest. */
export const HEALTH_REPORT_INCIDENT_LIMIT = 10;
/** Provider rows the text output lists; `--json` carries every failing row. */
const TEXT_PROVIDER_ROWS = 10;
const WIDTH = 100;

export type HealthReport = {
  kind: "health";
  version: typeof HEALTH_REPORT_VERSION;
  range: AdminHealthRange;
  from: string;
  to: string;
  generatedAt: string;
  /** False when no telemetry at all was recorded in the range. */
  hasTelemetry: boolean;
  /** "Needs attention" items of the health and queue rules, evaluated now over their own windows. */
  attention: AdminAttentionItem[];
  summary: AdminHealthSummary;
  /** Error and fatal records over the range per chart category. */
  errorsByCategory: Record<AdminHealthCategory, number>;
  /** Provider rows with at least one failure, most failures first. */
  providerFailures: AdminHealthProviderRow[];
  /** The provider grouping hit its row bound; some rows may be missing. */
  providersTruncated: boolean;
  /** Roles that started more than once in the range. */
  restarts: AdminHealthRoleStarts[];
  /** Background queues that are slow, stalled or could not be read. */
  queues: AdminHealthQueueRow[];
  queuesCheckedAt: string;
  /** The newest error and fatal incidents of the range, newest first. */
  incidents: AdminHealthIncident[];
  /** More incidents exist in the range than are listed. */
  incidentsTruncated: boolean;
};

export type HealthRunReport = {
  kind: "run";
  version: typeof HEALTH_REPORT_VERSION;
  /** The normalized reference that was looked up. */
  reference: string;
  runs: AdminHealthRunSummary[];
  /** More runs share this reference than are listed. */
  truncated: boolean;
  /** Retained incidents linked to the reference, newest first. */
  incidents: AdminHealthIncident[];
  incidentsTruncated: boolean;
};

/** A provider connection as the attention copy names it; a missing or disabled one stays quiet. */
export type HealthReportConnection = Readonly<{ id: string; displayName: string; enabled: boolean }>;

export type HealthReportSources = Readonly<{
  health: Pick<AdminHealthService, "incidents" | "read">;
  queues: Pick<AdminHealthQueuesService, "read">;
  findings(): Promise<readonly HealthFinding[]>;
  connections(): Promise<readonly HealthReportConnection[]>;
}>;

export type HealthRunReportSources = Readonly<{
  health: Pick<AdminHealthService, "incidents">;
  runs: AdminHealthRunLookup;
}>;

function incidentFilters(range: AdminHealthRange, q: string | null): AdminHealthIncidentFilters {
  return { category: null, code: null, cursor: null, event: null, level: null, q, range };
}

export async function collectHealthReport(sources: HealthReportSources, range: AdminHealthRange): Promise<HealthReport> {
  // The counters first: an unreachable database fails once instead of once per queue.
  const health = await sources.health.read(range);
  const [queues, findings, connections, page] = await Promise.all([
    sources.queues.read(),
    sources.findings(),
    sources.connections(),
    sources.health.incidents(incidentFilters(range, null))
  ]);
  const errorsByCategory = Object.fromEntries(adminHealthCategories.map((category) =>
    [category, health.series.reduce((total, bucket) => total + bucket.counts[category], 0)])) as Record<AdminHealthCategory, number>;
  return {
    kind: "health",
    version: HEALTH_REPORT_VERSION,
    range: health.range,
    from: health.from,
    to: health.to,
    generatedAt: health.generatedAt,
    hasTelemetry: health.hasTelemetry,
    attention: [
      ...healthAttentionItems(findings, connections),
      ...queueAttentionItems(adminHealthQueueFindings(queues.queues))
    ],
    summary: health.summary,
    errorsByCategory,
    providerFailures: health.providers.filter((row) => row.failures > 0)
      .sort((left, right) => right.failures - left.failures || left.key.localeCompare(right.key)),
    providersTruncated: health.providersTruncated,
    restarts: health.summary.roleStarts.filter((role) => role.restarts > 0),
    queues: queues.queues.filter((row) => row.state !== "ok"),
    queuesCheckedAt: queues.checkedAt,
    incidents: page.incidents.slice(0, HEALTH_REPORT_INCIDENT_LIMIT),
    incidentsTruncated: page.incidents.length > HEALTH_REPORT_INCIDENT_LIMIT || page.nextCursor !== null
  };
}

/** Runs sharing the reference plus the incidents linked to it over the longest retained range. */
export async function collectHealthRunReport(sources: HealthRunReportSources, reference: string): Promise<HealthRunReport> {
  const normalized = normalizeRunReference(reference);
  if (normalized === null) throw new TypeError("health_report_reference_invalid");
  const longest = adminHealthRanges[adminHealthRanges.length - 1]!;
  const [lookup, page] = await Promise.all([
    sources.runs.lookup(normalized),
    sources.health.incidents(incidentFilters(longest, normalized))
  ]);
  return {
    kind: "run",
    version: HEALTH_REPORT_VERSION,
    reference: normalized,
    runs: lookup.runs,
    truncated: lookup.truncated,
    incidents: page.incidents.slice(0, HEALTH_REPORT_INCIDENT_LIMIT),
    incidentsTruncated: page.incidents.length > HEALTH_REPORT_INCIDENT_LIMIT || page.nextCursor !== null
  };
}

// --- Arguments

export type HealthReportArgs = Readonly<{ help: boolean; json: boolean; range: AdminHealthRange; run: string | null }>;

export const HEALTH_REPORT_USAGE = `Usage: health-report [--since ${adminHealthRanges.join("|")}] [--json] [--run <reference>]`;

/** Strict flags: an unknown, repeated or malformed one is a usage error, never ignored. */
export function parseHealthReportArgs(argv: readonly string[]): HealthReportArgs | Readonly<{ error: string }> {
  let help = false;
  let json = false;
  let range: AdminHealthRange | null = null;
  let run: string | null = null;
  const queue = [...argv];
  while (queue.length > 0) {
    const argument = queue.shift()!;
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const flag = equals > 0 ? argument.slice(0, equals) : argument;
    const inline = equals > 0 ? argument.slice(equals + 1) : null;
    const value = () => inline ?? (queue[0] !== undefined && !queue[0].startsWith("--") ? queue.shift()! : null);
    switch (flag) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--json":
        if (inline !== null) return { error: "--json takes no value." };
        json = true;
        break;
      case "--since": {
        const since = value();
        if (range !== null) return { error: "--since was given twice." };
        if (!isAdminHealthRange(since)) return { error: `--since must be one of ${adminHealthRanges.join(", ")}.` };
        range = since;
        break;
      }
      case "--run": {
        const reference = value();
        if (run !== null) return { error: "--run was given twice." };
        const normalized = reference === null ? null : normalizeRunReference(reference);
        if (normalized === null) return { error: "--run needs an error reference: at least the first 8 characters of a run id." };
        run = normalized;
        break;
      }
      default:
        return { error: `Unknown argument: ${argument}` };
    }
  }
  if (run !== null && range !== null) return { error: "--run and --since are mutually exclusive." };
  return { help, json, range: range ?? defaultAdminHealthRange, run };
}

// --- Text

const RANGE_COPY: Readonly<Record<AdminHealthRange, string>> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const SEVERITY_TAG = { bad: "BAD ", neutral: "INFO", warn: "WARN" } as const;

function minute(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function second(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function fit(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

/**
 * Joins parts with `separator`, breaking between parts before `WIDTH` columns.
 * Continuation lines take the first line's indent width; a part longer than a
 * line stays whole.
 */
function wrapParts(parts: readonly string[], first: string, separator: string): string[] {
  const indent = " ".repeat(first.length);
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const part of parts) {
    if (!empty && line.length + separator.length + part.length > WIDTH) {
      lines.push(line.trimEnd());
      line = indent;
      empty = true;
    }
    line += empty ? part : `${separator}${part}`;
    empty = false;
  }
  if (!empty) lines.push(line);
  return lines;
}

function wrap(text: string, indent: string): string[] {
  return wrapParts(text.split(/\s+/u).filter(Boolean), indent, " ");
}

function duration(ms: number | null): string {
  if (ms === null) return "still running";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function mainCause(row: AdminHealthProviderRow): string {
  let best: string = "-";
  let most = 0;
  for (const failureClass of adminHealthFailureClasses) {
    if (row.failuresByClass[failureClass] > most) {
      best = failureClass;
      most = row.failuresByClass[failureClass];
    }
  }
  return best;
}

function incidentLines(incident: AdminHealthIncident): string[] {
  const head = [second(incident.occurredAt), incident.level, incident.role, incident.event];
  if (incident.runId !== null) head.push(`ref ${runReferenceLabel(incident.runId)}`);
  const where = [incident.subsystem, incident.stage].filter((part): part is string => part !== null).join("/");
  const detail = [
    incident.code === null ? null : `code ${incident.code}`,
    where || null,
    incident.connectionName,
    incident.modelName,
    incident.httpStatus === null ? null : `HTTP ${incident.httpStatus}`
  ].filter((part): part is string => part !== null);
  return [...wrapParts(head, "  ", "  "), ...wrapParts(detail, "      ", " · ")];
}

type Section = (report: HealthReport) => string[];

function attentionSection(report: HealthReport): string[] {
  if (report.attention.length === 0) return [];
  return [
    `Needs attention (${report.attention.length})`,
    ...report.attention.flatMap((item) => [
      `  ${SEVERITY_TAG[item.severity]}  ${item.title}`,
      ...wrap(item.detail, "        ")
    ])
  ];
}

function errorSection(report: HealthReport): string[] {
  const { summary } = report;
  if (summary.errors === 0 && summary.http5xx === 0 && summary.providerFailures === 0 &&
    summary.droppedLogRecords === 0 && summary.clientErrors === 0) return [];
  const previous = summary.previousErrors === null ? "" : ` (previous ${RANGE_COPY[report.range]}: ${summary.previousErrors})`;
  const areas = adminHealthCategories.filter((category) => report.errorsByCategory[category] > 0)
    .map((category) => `${category} ${report.errorsByCategory[category]}`);
  const other = [
    summary.http5xx > 0 ? `server errors ${summary.http5xx}` : null,
    summary.providerFailures > 0
      ? `provider failures ${summary.providerFailures} of ${summary.providerOperations} (${percent(summary.providerFailureRate)})` : null,
    summary.droppedLogRecords > 0 ? `dropped log lines ${summary.droppedLogRecords}` : null,
    summary.clientErrors > 0 ? `browser crashes ${summary.clientErrors}` : null
  ].filter((part): part is string => part !== null);
  return [
    `Error totals: ${summary.errors}${previous}`,
    ...wrapParts(areas, "  By area: ", " · "),
    ...wrapParts(other, "  ", " · ")
  ];
}

function providerSection(report: HealthReport): string[] {
  if (report.providerFailures.length === 0) return [];
  const shown = report.providerFailures.slice(0, TEXT_PROVIDER_ROWS);
  const hidden = report.providerFailures.length - shown.length;
  return [
    "Provider failures",
    `  ${fit("CONNECTION · MODEL", 30)}  ${fit("STAGE", 10)}  ${"FAILED".padStart(11)}  ${"RATE".padStart(6)}  ${fit("MAIN CAUSE", 14)}  LAST FAILURE`,
    ...shown.map((row) => {
      const name = row.modelName === null ? row.connectionName : `${row.connectionName} · ${row.modelName}`;
      return `  ${fit(name, 30)}  ${fit(row.stage ?? "-", 10)}  ${`${row.failures}/${row.operations}`.padStart(11)}  ` +
        `${percent(row.failureRate).padStart(6)}  ${fit(mainCause(row), 14)}  ${row.lastFailureAt === null ? "-" : minute(row.lastFailureAt)}`;
    }),
    ...(hidden > 0 ? [`  and ${plural(hidden, "more row")} (--json lists every row)`] : []),
    ...(report.providersTruncated ? ["  Some provider rows were left out: the grouping reached its row limit."] : [])
  ];
}

function restartSection(report: HealthReport): string[] {
  if (report.restarts.length === 0) return [];
  return [
    "Process restarts",
    ...report.restarts.map((role) => `  ${role.role}: ${plural(role.starts, "start")} (${plural(role.restarts, "restart")})`)
  ];
}

function queueSection(report: HealthReport): string[] {
  if (report.queues.length === 0) return [];
  return [
    "Background queues",
    ...report.queues.flatMap((row) => {
      const label = adminHealthQueueCopy[row.queue].label;
      const tag = `  ${fit(row.state.toUpperCase(), 11)}  `;
      if (row.state === "unavailable") return wrapParts([label, "could not be read"], tag, " · ");
      const parts = [label, `${row.waiting ?? 0} waiting, ${row.running ?? 0} running`];
      if (row.oldestSeconds !== null) parts.push(`oldest due ${queueAgeCopy(row.oldestSeconds)} ago`);
      if (row.failed24h) parts.push(`${row.failed24h} failed in 24 hours`);
      return wrapParts(parts, tag, " · ");
    })
  ];
}

function incidentSection(report: HealthReport): string[] {
  if (report.incidents.length === 0) return [];
  return [
    `Latest incidents (UTC, newest first${report.incidentsTruncated ? `; ${report.incidents.length} shown, Control Center Health lists the rest` : ""})`,
    ...report.incidents.flatMap(incidentLines)
  ];
}

/** Report sections in order, attention first; a section without findings prints nothing. */
const SECTIONS: readonly Section[] = [attentionSection, errorSection, providerSection, restartSection, queueSection, incidentSection];

export function formatHealthReport(report: HealthReport): string {
  const header = `AIQSA health · last ${RANGE_COPY[report.range]} · ${minute(report.from)} to ${minute(report.to)} UTC`;
  const sections = SECTIONS.map((section) => section(report)).filter((lines) => lines.length > 0);
  if (sections.length === 0) {
    return [
      header,
      "",
      `No problems recorded in the last ${RANGE_COPY[report.range]}.`,
      ...(report.hasTelemetry ? [] : ["No telemetry at all was recorded in this range."])
    ].join("\n") + "\n";
  }
  const footer = report.incidents.some((incident) => incident.runId !== null)
    ? ["Look up a reference: ./aiqsa.sh health --run <reference>"] : [];
  return [header, ...sections.flatMap((lines) => ["", ...lines]), ...(footer.length > 0 ? ["", ...footer] : [])].join("\n") + "\n";
}

export function formatHealthRunReport(report: HealthRunReport): string {
  const lines = [`AIQSA run lookup · reference ${report.reference}`, ""];
  if (report.runs.length === 0) {
    lines.push(`No run matches reference ${report.reference}.`);
  } else {
    for (const run of report.runs) {
      lines.push(`  ${run.runId}`);
      lines.push(...wrap(`${run.status} · started ${second(run.startedAt)} UTC · ${run.durationMs === null
        ? `still running, last change ${second(run.updatedAt)} UTC` : `took ${duration(run.durationMs)}`}`, "    "));
      lines.push(...wrapParts([
        run.failureCode === null ? null : `failure ${run.failureCode}`,
        run.connectionName,
        run.modelName,
        plural(run.incidentCount, "incident")
      ].filter((part): part is string => part !== null), "    ", " · "));
    }
    if (report.truncated) lines.push("  More runs share this reference; give more characters of the run id.");
  }
  if (report.incidents.length > 0) {
    lines.push("", `Incidents for this reference (UTC, newest first${report.incidentsTruncated
      ? `; ${report.incidents.length} shown, Control Center Health lists the rest` : ""})`);
    lines.push(...report.incidents.flatMap(incidentLines));
  }
  return lines.join("\n") + "\n";
}
