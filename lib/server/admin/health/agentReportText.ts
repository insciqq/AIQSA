import { adminHealthQueueCopy } from "../../../contracts/adminHealthQueues";
import { queueAgeCopy } from "../attention/queueRules";
import {
  HEALTH_AGENT_PRIVACY_NOTICE,
  type HealthAgentIncident,
  type HealthDurationStats,
  type HealthFullIncident,
  type HealthFullReport,
  type HealthLatencyProviderRow,
  type HealthProblemReportRow,
  type HealthRunTotals,
  type HealthUserReport
} from "./agentReport";
import { duration, fit, incidentLines, minute, percent, plural, RANGE_COPY, second, wrap, wrapParts } from "./report";

/**
 * Text of the agent reports: every section is printed, an empty one as
 * "none", and a cut list says so in its heading. Lines stay within 100
 * columns except a single part longer than a line.
 */

type Seen = Readonly<{ count: number; firstSeenAt: string; lastSeenAt: string }>;

const ROW_INDENT = "         ";

function present(parts: ReadonlyArray<string | null | false | undefined>): string[] {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0);
}

function seenParts(row: Seen): string[] {
  return [plural(row.count, "time"), `first ${minute(row.firstSeenAt)}`, `last ${minute(row.lastSeenAt)}`];
}

function bound(ms: number | null): string {
  return ms === null ? "-" : `≤ ${duration(ms)}`;
}

function statParts(stats: HealthDurationStats): string[] {
  if (stats.measured === 0) return ["no durations"];
  return [`${stats.measured} measured`, `p50 ${bound(stats.p50Ms)}`, `p95 ${bound(stats.p95Ms)}`,
    `max ${stats.maxMs === null ? "-" : duration(stats.maxMs)}`];
}

function heading(title: string, shown: number, truncated: boolean): string {
  return truncated ? `${title} (${shown} shown; more exist)` : `${title} (${shown})`;
}

function section(title: string, lines: readonly string[]): string[] {
  return [title, ...(lines.length > 0 ? lines : ["  none"])];
}

function tagged(tag: string, parts: readonly string[], details: readonly string[]): string[] {
  return [...wrapParts(parts, `  ${fit(tag.toUpperCase(), 5)}  `, " · "), ...wrapParts(details, ROW_INDENT, " · ")];
}

function plain(parts: readonly string[], details: readonly string[]): string[] {
  return [...wrapParts(parts, "  ", " · "), ...wrapParts(details, "      ", " · ")];
}

/** User text on one line, without terminal control or bidirectional override characters. */
function inert(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function runTotalParts(totals: HealthRunTotals): string[] {
  return [
    `completed ${totals.completed}`,
    `failed ${totals.failed} (${percent(totals.failureRate)})`,
    `cancelled ${totals.cancelled} (${percent(totals.cancelRate)})`
  ];
}

function runSection(report: HealthFullReport): string[] {
  const { runs } = report;
  return section("Runs (accepted runs; outcomes counted once per run from its terminal write)", [
    ...wrapParts([`accepted ${runs.accepted}: send ${runs.acceptedByKind.send}`, `regenerate ${runs.acceptedByKind.regenerate}`,
      `project ${runs.acceptedByKind.project}`], "  ", " · "),
    ...wrapParts([...runTotalParts(runs), `stop requests ${runs.stopRequests}`], "  ", " · "),
    ...wrapParts([`failed during preparation ${runs.failedInPreparation}`, `failed in recovery ${runs.failedInRecovery}`,
      `terminal write unconfirmed ${runs.unconfirmed}`], "  ", " · "),
    ...(runs.previous === null ? ["  previous period: beyond counter retention"]
      : wrapParts([`accepted ${runs.previous.accepted}`, ...runTotalParts(runs.previous)],
        `  previous ${RANGE_COPY[report.range]}: `, " · "))
  ]);
}

function providerName(row: HealthLatencyProviderRow): string {
  return present([row.providerFamily, row.connectionName, row.modelName]).join(" · ") || "unattributed";
}

function latencySection(report: HealthFullReport): string[] {
  const { latency } = report;
  const providerLines = (title: string, rows: readonly HealthLatencyProviderRow[]) => rows.length === 0 ? [] : [
    `  ${title}`,
    ...rows.flatMap((row) => wrapParts([fit(providerName(row), 40), ...statParts(row)], "    ", "  "))
  ];
  return section(`Latency (percentiles are histogram bucket upper bounds${latency.truncated ? "; some groups cut" : ""})`, [
    ...wrapParts(statParts(latency.runDuration), `  ${fit("run duration", 16)}  `, " · "),
    ...wrapParts(statParts(latency.firstOutput), `  ${fit("first output", 16)}  `, " · "),
    ...latency.firstOutput.byAfter.flatMap((row) =>
      wrapParts(statParts(row), `    ${fit(`after ${row.after ?? "unknown"}`, 14)}  `, " · ")),
    ...providerLines("Run duration by provider", latency.runDuration.byProvider),
    ...providerLines("First output by provider", latency.firstOutput.byProvider)
  ]);
}

function failureSection(report: HealthFullReport): string[] {
  const { failures } = report;
  return section(heading("Failures: warn, error and fatal records by key", failures.rows.length, failures.truncated),
    failures.rows.flatMap((row) => tagged(row.level, present([
      row.event,
      row.overflow ? "overflow (fields dropped)" : null,
      row.code && `code ${row.code}`,
      row.subsystem && `subsystem ${row.subsystem}`,
      row.stage && `stage ${row.stage}`,
      row.reason && `reason ${row.reason}`,
      row.routePath,
      row.status !== null && `status ${row.status}`,
      row.httpStatus !== null && `HTTP ${row.httpStatus}`,
      row.providerFamily,
      row.toolKind && `tool ${row.toolKind}`
    ]), [...seenParts(row), `version ${row.appVersions.join(", ") || "-"}`])));
}

function timeoutSection(report: HealthFullReport): string[] {
  const { timeouts } = report;
  return section(heading("Timeouts: deadline aborts, transport timeouts, tool and run deadlines", timeouts.rows.length, timeouts.truncated),
    timeouts.rows.flatMap((row) => plain(present([
      row.event, row.layer && `layer ${row.layer}`, row.abortSource, row.stage && `stage ${row.stage}`,
      row.operation, row.providerFamily, row.toolKind && `tool ${row.toolKind}`, row.code && `code ${row.code}`
    ]), seenParts(row))));
}

function errorGroupSection(report: HealthFullReport): string[] {
  const { errorGroups } = report;
  return section(heading("Error groups (class · where in AIQSA; NEW = first seen in this range)", errorGroups.rows.length,
    errorGroups.truncated), errorGroups.rows.flatMap((group) => tagged(group.newInRange ? "new" : "", [
    `${group.errorClass} · ${group.site ?? "outside application code"}`
  ], [
    plural(group.count, "time"),
    ...(group.usersAtLeast > 0 ? [`at least ${plural(group.usersAtLeast, "user")}`] : []),
    ...(group.runsAtLeast > 0 ? [`at least ${plural(group.runsAtLeast, "run")}`] : []),
    ...group.events, ...group.codes, ...group.roles,
    `first ${minute(group.firstSeenAt)}`, `last ${minute(group.lastSeenAt)}`, `fingerprint ${group.fingerprint}`
  ])));
}

function signInSection(report: HealthFullReport): string[] {
  const { signIns } = report;
  return section(heading("Sign-in outcomes by method, step and code", signIns.rows.length, signIns.truncated),
    signIns.rows.flatMap((row) => plain(present([row.method ?? "method unknown", row.step, row.outcome, row.code && `code ${row.code}`]),
      seenParts(row))));
}

function toolSection(report: HealthFullReport): string[] {
  const { toolCalls } = report;
  const unfinished = toolCalls.rows.filter((row) => row.outcome !== "completed");
  return section(heading("Tool calls by family, then calls that did not complete by code", unfinished.length, toolCalls.truncated), [
    ...toolCalls.families.flatMap((family) => wrapParts([
      plural(family.calls, "call"), `failed ${family.failed}`, `timed out ${family.timedOut}`, `cancelled ${family.cancelled}`,
      ...statParts(family)
    ], `  ${fit(family.toolKind ?? "unknown", 16)}  `, " · ")),
    ...unfinished.flatMap((row) => plain(present([row.toolKind ?? "unknown", row.outcome, row.code && `code ${row.code}`]),
      seenParts(row)))
  ]);
}

function httpSection(report: HealthFullReport): string[] {
  const { http } = report;
  return section(heading("HTTP: 4xx and 5xx responses and failed requests by route", http.rows.length + http.clientErrors.length,
    http.truncated), [
    ...http.rows.flatMap((row) => tagged(row.level, present([
      row.event, row.method, row.routePath ?? "route unknown", row.status !== null && `status ${row.status}`, row.outcome,
      row.stage && `stage ${row.stage}`
    ]), seenParts(row))),
    ...http.clientErrors.flatMap((row) => tagged("warn", present(["client.error", row.kind, row.routePath ?? "route unknown"]),
      seenParts(row)))
  ]);
}

function problemReportLines(row: HealthProblemReportRow): string[] {
  return [
    ...wrapParts(present([second(row.reportedAt), row.reason, `user ${row.userId}`, row.runReference && `ref ${row.runReference}`]),
      "  ", "  "),
    ...wrapParts(present([row.connectionName, row.modelName, row.createdAt !== row.reportedAt && `first sent ${minute(row.createdAt)}`]),
      "      ", " · "),
    ...(row.comment === null || inert(row.comment) === "" ? [] : wrap(`comment: "${inert(row.comment)}"`, "      "))
  ];
}

function problemSection(title: string, reports: HealthFullReport["problemReports"]): string[] {
  return section(reports.truncated ? `${title} (${reports.rows.length} of ${reports.total}, newest first)`
    : `${title} (${reports.rows.length}, newest first)`, reports.rows.flatMap(problemReportLines));
}

function agentIncidentLines(incident: HealthAgentIncident | HealthFullIncident): string[] {
  return [
    ...incidentLines(incident),
    ...wrapParts(present([
      incident.userId && `user ${incident.userId}`,
      `version ${incident.appVersion}`,
      incident.fingerprint && `fingerprint ${incident.fingerprint}`,
      "firstOfKey" in incident && incident.firstOfKey && "first of its key"
    ]), "      ", " · ")
  ];
}

function incidentSection(report: HealthFullReport): string[] {
  const { incidents } = report;
  const cut = present([
    incidents.newestTruncated && `the newest ${incidents.newestLimit} and the first of each key`,
    incidents.firstOfKeyTruncated && "not every key's first"
  ]).join("; ");
  return [
    ...section(`Incidents (UTC, newest first; ${incidents.rows.length} listed${cut ? `: ${cut}` : ""})`,
      incidents.rows.flatMap(agentIncidentLines)),
    "",
    ...section(heading("Incident keys (event · code · subsystem · connection · fingerprint), most incidents first",
      incidents.keys.length, incidents.keysTruncated), incidents.keys.flatMap((key) => plain(
      present([plural(key.incidents, "incident"), key.event, key.code && `code ${key.code}`, key.subsystem, key.connectionName,
        key.fingerprint && `fingerprint ${key.fingerprint}`]),
      [`at least ${plural(key.usersAtLeast, "user")}`, `at least ${plural(key.runsAtLeast, "run")}`,
        `first ${minute(key.firstAt)}`, `last ${minute(key.lastAt)}`]
    )))
  ];
}

function operationSection(report: HealthFullReport): string[] {
  const { operations } = report;
  return section(`Operations${operations.truncated ? " (some rows cut)" : ""}`, [
    ...wrapParts(operations.roleStarts.map((role) => `${role.role} ${plural(role.starts, "start")}` +
      (role.restarts > 0 ? ` (${plural(role.restarts, "restart")})` : "")), "  Process starts: ", " · "),
    `  Dropped log lines: ${operations.droppedLogRecords.records} in ${plural(operations.droppedLogRecords.reports, "report")}`,
    `  Background queues (checked ${second(operations.queuesCheckedAt)} UTC)`,
    ...operations.queues.flatMap((row) => {
      const label = adminHealthQueueCopy[row.queue].label;
      if (row.state === "unavailable") return wrapParts([label, "could not be read"], `    ${fit("UNAVAILABLE", 11)}  `, " · ");
      return wrapParts(present([label, `${row.waiting ?? 0} waiting, ${row.running ?? 0} running`,
        row.oldestSeconds !== null && `oldest due ${queueAgeCopy(row.oldestSeconds)} ago`,
        row.failed24h ? `${row.failed24h} failed in 24 hours` : null]), `    ${fit(row.state.toUpperCase(), 11)}  `, " · ");
    }),
    "  Telemetry recording problems",
    ...(operations.telemetry.length === 0 ? ["    none"] : operations.telemetry.flatMap((row) => wrapParts(present([
      row.level.toUpperCase(), row.stage, row.outcome, row.code && `code ${row.code}`, row.action && `action ${row.action}`,
      ...seenParts(row)
    ]), "    ", " · "))),
    "  Readiness changes",
    ...(operations.readiness.length === 0 ? ["    none"] : operations.readiness.flatMap((row) => wrapParts(present([
      row.state, row.code && `code ${row.code}`, ...seenParts(row)
    ]), "    ", " · ")))
  ]);
}

const FULL_SECTIONS: ReadonlyArray<(report: HealthFullReport) => string[]> = [
  runSection, latencySection, failureSection, timeoutSection, errorGroupSection, signInSection, toolSection, httpSection,
  (report) => problemSection("Answer problem reports", report.problemReports), incidentSection, operationSection
];

export function formatHealthFullReport(report: HealthFullReport): string {
  return [
    HEALTH_AGENT_PRIVACY_NOTICE,
    `AIQSA health · full report · last ${RANGE_COPY[report.range]} · ${minute(report.from)} to ${minute(report.to)} UTC`,
    "Counts are telemetry records unless named otherwise; incidents are a sample.",
    ...(report.hasTelemetry ? [] : ["No telemetry at all was recorded in this range."]),
    ...FULL_SECTIONS.flatMap((format) => ["", ...format(report)]),
    "",
    "Drill in: ./aiqsa.sh health --run <reference> · ./aiqsa.sh health --user <user id>"
  ].join("\n") + "\n";
}

export function formatHealthUserReport(report: HealthUserReport): string {
  const runs = report.failedRuns;
  return [
    HEALTH_AGENT_PRIVACY_NOTICE,
    `AIQSA health · user ${report.userId} · last ${RANGE_COPY[report.range]} · ${minute(report.from)} to ${minute(report.to)} UTC`,
    ...(report.userExists ? [] : ["No account has this id (any more)."]),
    "",
    ...section(heading("Failed and cancelled runs, newest first", runs.rows.length, runs.truncated), runs.rows.flatMap((run) => [
      `  ${run.runId}  ref ${run.runReference}`,
      ...wrap(`${run.status} · started ${second(run.startedAt)} UTC · took ${duration(run.durationMs)}`, "    "),
      ...wrapParts(present([run.failureCode && `failure ${run.failureCode}`, run.connectionName, run.modelName,
        plural(run.incidentCount, "incident")]), "    ", " · ")
    ])),
    "",
    ...section(heading("Incidents (UTC, newest first)", report.incidents.rows.length, report.incidents.truncated),
      report.incidents.rows.flatMap(agentIncidentLines)),
    "",
    ...problemSection("Answer problem reports", report.problemReports)
  ].join("\n") + "\n";
}
