import { Prisma } from "@prisma/client";
import toolNames from "../../observability/toolNames.json";
import type { ToolCallKind } from "../../observability";
import type { TelemetryCounterGroup } from "../../telemetry/store";
import type { AdminHealthQueueClient } from "./queuesRepository";

const DAY = 86_400_000;
const KINDS: readonly ToolCallKind[] = ["search", "mcp", "workspace", "vision", "fetch_url", "artifact", "image_generation",
  "skill", "scheduled_task", "session_status", "workspace_image", "memory", "monitoring", "other"];
const names = Object.fromEntries(KINDS.map((kind) => [kind,
  Object.entries(toolNames).filter(([, family]) => family === kind).map(([name]) => name)]));
const MAX_TOOLS = 200;

export type HealthReach = Readonly<{
  activeUsers: number;
  runs: number;
  /** Runs per user with at least one accepted run; no individual identities. */
  runsPerActiveUser: number | null;
  weekly: readonly Readonly<{ from: string; to: string; activeUsers: number; runs: number }>[];
  /** Users include hosted Search; call rates describe model tool calls only. */
  tools: readonly Readonly<{ kind: ToolCallKind; users: number; calls: number; failed: number; cancelled: number;
    awaitingApproval: number; failureRate: number | null }>[];
  perTool: readonly Readonly<{ tool: string; users: number; calls: number; failed: number; failureRate: number | null }>[];
  toolsTruncated: boolean;
  features: readonly Readonly<{ feature: "search" | "assistants" | "scheduled_tasks" | "workspace" | "skills"; users: number }>[];
  /** Only provider-reported searches, never an estimate from SearchRun rows. */
  reportedWebSearches: number;
  /** Calls that overflowed telemetry dimensions cannot be assigned to a tool. */
  unclassifiedToolCalls: number;
}>;

type Span = Readonly<{ from: Date; to: Date }>;
type ReachRow = { section: "summary" | "week" | "tool" | "feature" | "detail"; key: string; users: number | bigint;
  runs: number | bigint; searches: number | bigint; from: Date | null; to: Date | null };

const utc = (date: Date) => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

/** One bounded aggregate over existing rows. Names and user ids never leave PostgreSQL. */
export function healthReachStatement(span: Span): Prisma.Sql {
  if (!Number.isFinite(span.from.getTime()) || !Number.isFinite(span.to.getTime()) || span.to <= span.from ||
    span.to.getTime() - span.from.getTime() > 31 * DAY) throw new RangeError("health_reach_window_invalid");
  const weeklyFrom = new Date(span.to.getTime() - Math.max(7, Math.ceil((span.to.getTime() - span.from.getTime()) / (7 * DAY)) * 7) * DAY);
  const toolKind = Prisma.sql`CASE WHEN call."mcpRunBindingId" IS NOT NULL THEN 'mcp'
    ${Prisma.join(Object.entries(names).map(([kind, tools]) => Prisma.sql`WHEN call."toolName" = ANY(${tools}::text[]) THEN ${kind}`), " ")}
    WHEN call."workspaceRunBindingId" IS NOT NULL THEN 'workspace' ELSE 'other' END`;
  const identity = Prisma.sql`CASE WHEN call."mcpRunBindingId" IS NOT NULL
      THEN 'mcp_' || left(encode(sha256(convert_to(call."toolName", 'UTF8')), 'hex'), 32)
      WHEN call."toolName" = ANY(${Object.keys(toolNames)}::text[]) THEN call."toolName" ELSE 'other' END`;
  return Prisma.sql`
    WITH runs AS MATERIALIZED (
      SELECT "id", "userId", "createdAt", "assistantId", "scheduledTaskId"
      FROM "ModelRun" WHERE "createdAt" >= ${utc(weeklyFrom)} AND "createdAt" < ${utc(span.to)}
        AND "subagentThreadId" IS NULL
    ), selected AS (
      SELECT * FROM runs WHERE "createdAt" >= ${utc(span.from)}
    ), calls AS MATERIALIZED (
      SELECT run."userId", ${toolKind} AS kind, ${identity} AS identity
      FROM "ModelRunToolCall" call JOIN "ModelRun" run ON run."id" = call."modelRunId"
      WHERE call."createdAt" >= ${utc(span.from)} AND call."createdAt" < ${utc(span.to)}
    ), usage AS MATERIALIZED (
      SELECT "userId", "webSearchCount" FROM "UsageEvent"
      WHERE "createdAt" >= ${utc(span.from)} AND "createdAt" < ${utc(span.to)} AND "webSearchCount" > 0
    ), search_users AS (
      SELECT "userId" FROM usage UNION SELECT "userId" FROM calls WHERE kind = 'search'
      UNION SELECT run."userId" FROM "SearchRun" search JOIN "ModelRun" run ON run."id" = search."modelRunId"
        WHERE search."createdAt" >= ${utc(span.from)} AND search."createdAt" < ${utc(span.to)}
    ), tool_users AS (
      SELECT "userId", kind FROM calls UNION SELECT "userId", 'search' FROM search_users
    ), features AS (
      SELECT "userId", 'search' AS feature FROM search_users
      UNION SELECT "userId", 'assistants' FROM selected WHERE "assistantId" IS NOT NULL
      UNION SELECT "userId", 'scheduled_tasks' FROM selected WHERE "scheduledTaskId" IS NOT NULL
      UNION SELECT run."userId", 'workspace' FROM selected run JOIN "WorkspaceRunBinding" binding ON binding."modelRunId" = run."id"
      UNION SELECT run."userId", 'skills' FROM selected run JOIN "ModelRunSkillBinding" binding ON binding."modelRunId" = run."id"
    ), tool_details AS (
      SELECT identity, count(DISTINCT "userId") AS users FROM calls GROUP BY identity ORDER BY count(*) DESC, identity LIMIT ${MAX_TOOLS + 1}
    ), weeks AS (
      SELECT start AS "from", start + interval '7 days' AS "to"
      FROM generate_series(${utc(weeklyFrom)}, ${utc(span.to)} - interval '7 days', interval '7 days') start
    )
    SELECT 'summary' AS section, '' AS key, count(DISTINCT "userId") AS users, count(*) AS runs,
      COALESCE((SELECT sum("webSearchCount") FROM usage), 0)::bigint AS searches, NULL::timestamp AS "from", NULL::timestamp AS "to" FROM selected
    UNION ALL SELECT 'week', '', count(DISTINCT runs."userId"), count(runs."id"), 0, weeks."from", weeks."to"
      FROM weeks LEFT JOIN runs ON runs."createdAt" >= weeks."from" AND runs."createdAt" < weeks."to" GROUP BY weeks."from", weeks."to"
    UNION ALL SELECT 'tool', kind, count(DISTINCT "userId"), 0, 0, NULL, NULL FROM tool_users GROUP BY kind
    UNION ALL SELECT 'detail', identity, users, 0, 0, NULL, NULL FROM tool_details
    UNION ALL SELECT 'feature', feature, count(DISTINCT "userId"), 0, 0, NULL, NULL FROM features GROUP BY feature
  `;
}

function count(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("health_reach_count_invalid");
  return result;
}

export const HEALTH_TOOL_CALL_QUERY = { events: ["tool_call"], groupBy: ["tool_identity", "tool_kind", "outcome"], limit: 1601 } as const;

/** Terminal calls are counted once. Stops and approval waits do not enter the failure-rate denominator. */
export function healthToolRates(rows: readonly TelemetryCounterGroup[]) {
  const byKind = new Map<ToolCallKind, { calls: number; failed: number; cancelled: number; awaitingApproval: number }>();
  let unclassified = 0;
  for (const row of rows) {
    const kind = row.group.tool_kind as ToolCallKind;
    const outcome = row.group.outcome;
    if (!KINDS.includes(kind)) { unclassified += row.count; continue; }
    const entry = byKind.get(kind) ?? { calls: 0, failed: 0, cancelled: 0, awaitingApproval: 0 };
    if (outcome === "awaiting_approval") entry.awaitingApproval += row.count;
    else if (outcome === "completed" || outcome === "failed" || outcome === "timeout" || outcome === "cancelled") {
      entry.calls += row.count;
      if (outcome === "failed" || outcome === "timeout") entry.failed += row.count;
      if (outcome === "cancelled") entry.cancelled += row.count;
    }
    byKind.set(kind, entry);
  }
  return { byKind, unclassified };
}

export async function readHealthReach(client: AdminHealthQueueClient, span: Span,
  counters: readonly TelemetryCounterGroup[]): Promise<HealthReach> {
  const statement = healthReachStatement(span);
  const [, rows] = await client.$transaction([
    client.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', '15000', true)`),
    client.$queryRaw<ReachRow[]>(statement)
  ]);
  const summary = rows.find((row) => row.section === "summary");
  if (!summary) throw new Error("health_reach_summary_missing");
  const activeUsers = count(summary.users), runs = count(summary.runs);
  const rates = healthToolRates(counters);
  const tools = KINDS.flatMap((kind) => {
    const reach = rows.find((row) => row.section === "tool" && row.key === kind);
    const rate = rates.byKind.get(kind);
    if (!reach && !rate) return [];
    const totals = rate ?? { calls: 0, failed: 0, cancelled: 0, awaitingApproval: 0 };
    const denominator = totals.calls - totals.cancelled;
    return [{ kind, users: reach ? count(reach.users) : 0, ...totals,
      failureRate: denominator > 0 ? totals.failed / denominator : null }];
  });
  const features = (["search", "assistants", "scheduled_tasks", "workspace", "skills"] as const).map((feature) => {
    const row = rows.find((value) => value.section === "feature" && value.key === feature);
    return { feature, users: row ? count(row.users) : 0 };
  });
  const toolRows = rows.filter((row) => row.section === "detail");
  const identities = new Set([...toolRows.map((row) => row.key), ...counters.flatMap((row) =>
    typeof row.group.tool_identity === "string" ? [row.group.tool_identity] : [])]);
  const perTool = [...identities].filter((tool) => tool === "other" || Object.hasOwn(toolNames, tool) || /^mcp_[0-9a-f]{32}$/u.test(tool))
    .map((tool) => {
      const userRow = toolRows.find((row) => row.key === tool);
      const toolRates = healthToolRates(counters.filter((row) => row.group.tool_identity === tool));
      const totals = [...toolRates.byKind.values()].reduce((sum, row) => ({ calls: sum.calls + row.calls,
        failed: sum.failed + row.failed, cancelled: sum.cancelled + row.cancelled }), { calls: 0, failed: 0, cancelled: 0 });
      const denominator = totals.calls - totals.cancelled;
      return { tool, users: userRow ? count(userRow.users) : 0, calls: totals.calls, failed: totals.failed,
        failureRate: denominator > 0 ? totals.failed / denominator : null };
    }).sort((left, right) => right.failed - left.failed || right.calls - left.calls || left.tool.localeCompare(right.tool));
  return {
    perTool: perTool.slice(0, MAX_TOOLS), toolsTruncated: toolRows.length > MAX_TOOLS || perTool.length > MAX_TOOLS || counters.length >= 1601,
    activeUsers, runs, runsPerActiveUser: activeUsers > 0 ? runs / activeUsers : null, tools, features,
    reportedWebSearches: count(summary.searches), unclassifiedToolCalls: rates.unclassified,
    weekly: rows.filter((row) => row.section === "week").map((row) => ({
      from: row.from!.toISOString(), to: row.to!.toISOString(), activeUsers: count(row.users), runs: count(row.runs)
    })).sort((left, right) => left.from.localeCompare(right.from))
  };
}
