// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { TELEMETRY_DURATION_BUCKETS, telemetryDurationBucket, type TelemetryCounterDelta, type TelemetryIncidentInput } from "../../telemetry/aggregator";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { collectHealthFullReport, collectHealthUserReport } from "./agentReport";
import { formatHealthFullReport } from "./agentReportText";
import { healthAgentReportSources } from "./reportDefault";

// Every row belongs to this file: its own app versions, user, chat, runs and
// marker-suffixed codes; only those are removed. Other rows in the database
// may add to shared totals, so totals are lower bounds and lists are filtered
// to this file's rows.
const MARK = randomBytes(6).toString("hex");
const VERSION = `agent-report-${MARK}`;
const VERSION_B = `agent-report-b-${MARK}`;
const OWNER = `agent-report-owner-${randomUUID()}`;
const FINGERPRINT = randomBytes(6).toString("hex");
const CODE = `agent_code_${MARK}`;
const FAMILY = `family_${MARK}`;
const ROUTE = `/api/agent-report-${MARK}`;
const RUN_FAILED = randomUUID();
const RUN_CANCELLED = randomUUID();
const RUN_COMPLETE = randomUUID();
const HOUR_MS = 3_600_000;
const BUCKET = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS);
const store = createPrismaTelemetryStore(prisma);

function delta(event: string, level: TelemetryCounterDelta["level"], dimensions: Record<string, string | number>, count: number,
  options: Readonly<{ durations?: readonly number[]; appVersion?: string }> = {}): TelemetryCounterDelta {
  const durations = options.durations ?? [];
  const durationBuckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  for (const value of durations) durationBuckets[telemetryDurationBucket(value)]! += 1;
  return {
    bucketStart: BUCKET, role: "app", event, level, appVersion: options.appVersion ?? VERSION, dimensions, count, valueSum: 0,
    durationCount: durations.length, durationSumMs: durations.reduce((total, value) => total + value, 0),
    durationMaxMs: durations.length > 0 ? Math.max(...durations) : null, durationBuckets,
    firstSeenAt: BUCKET, lastSeenAt: new Date(BUCKET.getTime() + 60_000)
  };
}

function incident(minutesAgo: number, userId: string | null, runId: string | null): TelemetryIncidentInput {
  return {
    occurredAt: new Date(Date.now() - minutesAgo * 60_000), role: "app", event: "provider_operation", level: "error",
    appVersion: VERSION, instanceId: "b".repeat(32), code: CODE, subsystem: null, connectionId: null, runId, traceId: null, userId,
    details: { stage: "answer", error_class: "ProviderError", error_site: "lib/server/providers/x.ts:1", error_fingerprint: FINGERPRINT }
  };
}

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "TelemetryCounter" WHERE "appVersion" = ANY(${[VERSION, VERSION_B]}::text[])`;
  await prisma.$executeRaw`DELETE FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION}`;
  await prisma.user.deleteMany({ where: { id: OWNER } });
  await prisma.$disconnect();
});

describe("agent health reports over PostgreSQL", () => {
  it("reads every section from the real store and repositories, and one user's items only", async () => {
    await prisma.user.create({ data: { displayName: "Agent report owner", id: OWNER, status: "active" } });
    const chat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Private agent report title", userId: OWNER } });
    const question = await prisma.message.create({
      data: { chatId: chat.id, content: textMessageContent("Private agent report prompt"), role: "user", status: "complete" }
    });
    const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Private answer"),
      parentMessageId: question.id, role: "assistant", status: "error" } });
    const runs = [
      { id: RUN_COMPLETE, status: "complete", minutesAgo: 50 },
      { id: RUN_CANCELLED, status: "cancelled", minutesAgo: 40 },
      { id: RUN_FAILED, status: "error", minutesAgo: 30 }
    ] as const;
    for (const run of runs) {
      await prisma.modelRun.create({ data: {
        id: run.id, chatId: chat.id, userId: OWNER, userMessageId: question.id, provider: "agent-provider", modelId: "agent-model",
        status: run.status, normalizedRequest: {}, createdAt: new Date(Date.now() - run.minutesAgo * 60_000),
        ...(run.id === RUN_FAILED ? { assistantMessageId: answer.id,
          errorPayload: { code: "provider_rate_limited", message: "Private provider detail" } } : {})
      } });
    }
    await prisma.answerProblemReport.create({ data: { chatId: chat.id, messageId: answer.id, runId: RUN_FAILED, userId: OWNER,
      reason: "error_or_broken", comment: "Private agent comment" } });
    await store.write({
      counters: [
        delta("run_accepted", "info", { kind: "send" }, 3),
        delta("run_persistence", "info", { stage: "complete", outcome: "confirmed" }, 2),
        delta("run_persistence", "info", { stage: "fail", outcome: "confirmed" }, 1),
        delta("run_execution", "info", { stage: "execution", outcome: "completed", providerFamily: FAMILY }, 2, { durations: [700, 3_000] }),
        delta("provider_operation", "error", { stage: "answer", outcome: "failed", code: CODE, error_fingerprint: FINGERPRINT,
          error_class: "ProviderError", error_site: "lib/server/providers/x.ts:1" }, 4),
        delta("provider_operation", "error", { stage: "answer", outcome: "failed", code: CODE, error_fingerprint: FINGERPRINT,
          error_class: "ProviderError", error_site: "lib/server/providers/x.ts:1" }, 1, { appVersion: VERSION_B }),
        delta("nested_abort", "warn", { layer: "provider", stage: "delivery", abort_source: "provider_deadline", providerFamily: FAMILY }, 2),
        delta("transport_stage", "warn", { transport: "provider", stage: "stream", outcome: "failed", category: "timeout", code: CODE }, 1),
        delta("tool_call", "warn", { tool_kind: "fetch_url", outcome: "timeout", code: CODE }, 1, { durations: [15_000] }),
        delta("http.request_completed", "warn", { routePath: ROUTE, method: "GET", status: 404, outcome: "completed" }, 5)
      ],
      incidents: [incident(30, OWNER, RUN_FAILED), incident(10, OWNER, RUN_FAILED), incident(5, null, null)],
      lostObservations: 0
    });

    const full = await collectHealthFullReport(healthAgentReportSources, "24h");
    expect(full).toMatchObject({ privacy: "contains_user_ids_and_comments", kind: "full", version: 1, range: "24h", hasTelemetry: true });
    expect(full.runs.accepted).toBeGreaterThanOrEqual(3);
    expect(full.runs.completed).toBeGreaterThanOrEqual(2);
    expect(full.runs.failed).toBeGreaterThanOrEqual(1);
    expect(full.latency.runDuration.byProvider.filter((row) => row.providerFamily === FAMILY))
      .toEqual([expect.objectContaining({ measured: 2, p50Ms: 1_000, p95Ms: 3_000, maxMs: 3_000 })]);
    expect(full.failures.rows.filter((row) => row.code === CODE && row.event === "provider_operation"))
      .toEqual([expect.objectContaining({ level: "error", stage: "answer", count: 5, appVersions: [VERSION_B, VERSION].sort() })]);
    expect(full.timeouts.rows.filter((row) => row.providerFamily === FAMILY || row.code === CODE)
      .map((row) => [row.event, row.count]).sort()).toEqual([["nested_abort", 2], ["tool_call", 1], ["transport_stage", 1]]);
    expect(full.http.rows.filter((row) => row.routePath === ROUTE)).toEqual([expect.objectContaining({ level: "warn", status: 404, count: 5 })]);
    expect(full.errorGroups.rows.filter((row) => row.fingerprint === FINGERPRINT))
      .toEqual([expect.objectContaining({ count: 5, usersAtLeast: 1, runsAtLeast: 1, newInRange: true })]);
    expect(full.problemReports.rows.filter((row) => row.userId === OWNER)).toEqual([expect.objectContaining({
      reason: "error_or_broken", comment: "Private agent comment", runId: RUN_FAILED, runReference: RUN_FAILED.slice(0, 8) })]);
    const own = full.incidents.rows.filter((row) => row.code === CODE);
    expect(own.map((row) => [row.userId, row.firstOfKey])).toEqual([[null, false], [OWNER, false], [OWNER, true]]);
    expect(own[2]).toMatchObject({ runReference: RUN_FAILED.slice(0, 8), fingerprint: FINGERPRINT, errorClass: "ProviderError",
      appVersion: VERSION });
    expect(full.incidents.keys.filter((key) => key.code === CODE))
      .toEqual([expect.objectContaining({ incidents: 3, usersAtLeast: 1, runsAtLeast: 1, fingerprint: FINGERPRINT })]);
    expect(Array.isArray(full.operations.queues)).toBe(true);
    for (const flag of [full.failures.truncated, full.timeouts.truncated, full.incidents.newestTruncated, full.problemReports.truncated]) {
      expect(typeof flag).toBe("boolean");
    }
    const output = JSON.stringify(full) + formatHealthFullReport(full);
    expect(output).not.toMatch(/Private agent report|Private answer|Private provider detail|Agent report owner/u);

    const user = await collectHealthUserReport(healthAgentReportSources, OWNER, "24h");
    expect(user).toMatchObject({ kind: "user", userId: OWNER, userExists: true });
    expect(user.incidents.rows.map((row) => row.userId)).toEqual([OWNER, OWNER]);
    expect(user.failedRuns).toEqual({ truncated: false, rows: [
      expect.objectContaining({ runId: RUN_FAILED, status: "error", failureCode: "provider_rate_limited", incidentCount: 2 }),
      expect.objectContaining({ runId: RUN_CANCELLED, status: "cancelled", failureCode: null, incidentCount: 0 })
    ] });
    expect(user.problemReports).toEqual({ total: 1, truncated: false, rows: [expect.objectContaining({ userId: OWNER })] });
    expect(JSON.stringify(user)).not.toMatch(/Private agent report|Private answer|Private provider detail|Agent report owner/u);

    await expect(collectHealthUserReport(healthAgentReportSources, `missing-${MARK}`, "24h")).resolves.toMatchObject({
      userExists: false, incidents: { rows: [] }, failedRuns: { rows: [] }, problemReports: { rows: [], total: 0 }
    });
  });
});
