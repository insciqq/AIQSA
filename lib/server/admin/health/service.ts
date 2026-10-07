import {
  ADMIN_HEALTH_CATEGORY_EVENTS,
  adminHealthCategories,
  adminHealthEventCategory,
  adminHealthFailureClasses,
  ADMIN_HEALTH_TRACE_PATTERN,
  type AdminHealth,
  type AdminHealthCategory,
  type AdminHealthFailureClass,
  type AdminHealthIncident,
  type AdminHealthIncidentFilters,
  type AdminHealthIncidentsResponse,
  type AdminHealthProviderRow,
  type AdminHealthRange,
  type AdminHealthRoleStarts
} from "../../../contracts/adminHealth";
import { TELEMETRY_DURATION_BUCKETS } from "../../telemetry/aggregator";
import { normalizeRunReference, RUN_ID_LENGTH } from "../../../contracts/runReference";
import type { TelemetryCounterGroup, TelemetryGroupValue, TelemetryIncidentQuery, TelemetryStore } from "../../telemetry/store";
import {
  ADMIN_HEALTH_INCIDENT_DETAIL_KEYS,
  adminHealthFailureClass,
  adminHealthIncidentFrom,
  adminHealthP95,
  adminHealthWindow
} from "./projection";

/** Display names of the provider connections and models still present; a missing id was deleted. */
export type AdminHealthProviderNames = Readonly<{
  connections: ReadonlyMap<string, string>;
  models: ReadonlyMap<string, string>;
}>;

export type AdminHealthDependencies = Readonly<{
  store: Pick<TelemetryStore, "readCounters" | "readIncidents">;
  providerNames(input: Readonly<{ connectionIds: readonly string[]; modelIds: readonly string[] }>): Promise<AdminHealthProviderNames>;
  now?: () => Date;
}>;

export type AdminHealthService = Readonly<{
  read(range: AdminHealthRange): Promise<AdminHealth>;
  incidents(filters: AdminHealthIncidentFilters): Promise<AdminHealthIncidentsResponse>;
}>;

const ROW_LIMIT = 5_000;
const INCIDENT_PAGE = 50;
const MAX_NAME_IDS = 500;
const DELETED_CONNECTION = "Deleted connection";
const DELETED_MODEL = "Deleted model";
const UNATTRIBUTED = "Unattributed";

function textValue(value: TelemetryGroupValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: TelemetryGroupValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function emptyClasses(): Record<AdminHealthFailureClass, number> {
  return Object.fromEntries(adminHealthFailureClasses.map((key) => [key, 0])) as Record<AdminHealthFailureClass, number>;
}

function emptyCategories(): Record<AdminHealthCategory, number> {
  return Object.fromEntries(adminHealthCategories.map((key) => [key, 0])) as Record<AdminHealthCategory, number>;
}

function sum(rows: readonly TelemetryCounterGroup[], select: (row: TelemetryCounterGroup) => number): number {
  return rows.reduce((total, row) => total + select(row), 0);
}

type ProviderAccumulator = {
  connectionId: string | null;
  providerModelId: string | null;
  stage: string | null;
  operations: number;
  failures: number;
  failuresByClass: Record<AdminHealthFailureClass, number>;
  buckets: number[];
  maxMs: number | null;
  lastFailureAt: number | null;
};

/**
 * Folds provider counter groups into one row per connection, model and stage.
 * Only finished operations count: completed and final failures. Started
 * records, cancellations and intermediate polling failures (`action=retry`)
 * stay out of both the operations and the failures.
 */
function foldProviders(rows: readonly TelemetryCounterGroup[], stageOverride: string | null,
  target: Map<string, ProviderAccumulator>): void {
  for (const row of rows) {
    const outcome = textValue(row.group.outcome);
    const failed = outcome === "failed" && textValue(row.group.action) !== "retry";
    if (outcome !== "completed" && !failed) continue;
    const connectionId = textValue(row.group.connectionId);
    const providerModelId = textValue(row.group.providerModelId);
    const stage = stageOverride ?? textValue(row.group.stage);
    const key = JSON.stringify([connectionId, providerModelId, stage]);
    let entry = target.get(key);
    if (!entry) {
      entry = {
        connectionId, providerModelId, stage, operations: 0, failures: 0, failuresByClass: emptyClasses(),
        buckets: new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0), maxMs: null, lastFailureAt: null
      };
      target.set(key, entry);
    }
    entry.operations += row.count;
    if (failed) {
      entry.failures += row.count;
      const failureClass = adminHealthFailureClass(textValue(row.group.code), numberValue(row.group.httpStatus), textValue(row.group.reason));
      entry.failuresByClass[failureClass] += row.count;
      entry.lastFailureAt = Math.max(entry.lastFailureAt ?? 0, row.lastSeenAt.getTime());
    }
    row.durationBuckets.forEach((value, index) => {
      if (index < entry.buckets.length) entry.buckets[index] = (entry.buckets[index] ?? 0) + value;
    });
    if (row.durationMaxMs !== null) entry.maxMs = Math.max(entry.maxMs ?? 0, row.durationMaxMs);
  }
}

function connectionLabel(id: string | null, names: AdminHealthProviderNames): Pick<AdminHealthProviderRow, "connectionName" | "connectionState"> {
  if (id === null) return { connectionName: UNATTRIBUTED, connectionState: "unattributed" };
  const name = names.connections.get(id);
  return name === undefined ? { connectionName: DELETED_CONNECTION, connectionState: "deleted" }
    : { connectionName: name, connectionState: "known" };
}

function modelLabel(id: string | null, names: AdminHealthProviderNames): string | null {
  if (id === null) return null;
  return names.models.get(id) ?? DELETED_MODEL;
}

function boundedIds(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => value !== null))].slice(0, MAX_NAME_IDS);
}

function compareProviders(left: AdminHealthProviderRow, right: AdminHealthProviderRow): number {
  return right.failures - left.failures ||
    (right.failureRate ?? 0) - (left.failureRate ?? 0) ||
    right.operations - left.operations ||
    left.connectionName.localeCompare(right.connectionName) ||
    (left.modelName ?? "").localeCompare(right.modelName ?? "") ||
    (left.stage ?? "").localeCompare(right.stage ?? "");
}

function incidentDetails(details: Readonly<Record<string, string | number | boolean>>) {
  return Object.entries(details)
    .filter(([key]) => ADMIN_HEALTH_INCIDENT_DETAIL_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

/**
 * The search box value as an incident filter: a trace id, a run id, or an
 * error reference (a run-id prefix of at least eight characters).
 */
function referenceFilter(reference: string): Pick<TelemetryIncidentQuery, "runId" | "runIdPrefix" | "traceId"> {
  if (ADMIN_HEALTH_TRACE_PATTERN.test(reference)) return { traceId: reference };
  const run = normalizeRunReference(reference);
  if (run === null) return { runId: reference };
  return run.length === RUN_ID_LENGTH ? { runId: run } : { runIdPrefix: run };
}

export function createAdminHealthService(dependencies: AdminHealthDependencies): AdminHealthService {
  const now = dependencies.now ?? (() => new Date());
  const { store } = dependencies;

  return Object.freeze({
    async read(range: AdminHealthRange): Promise<AdminHealth> {
      const generatedAt = now();
      const window = adminHealthWindow(range, generatedAt);
      const base = { from: window.from, to: window.to, limit: ROW_LIMIT };
      const [totals, previous, series, providerRows, visionRows] = await Promise.all([
        store.readCounters({ ...base, groupBy: ["event", "level", "role"] }),
        window.previous
          ? store.readCounters({ ...window.previous, levels: ["error", "fatal"] })
          : Promise.resolve(null),
        store.readCounters({ ...base, levels: ["error", "fatal"], groupBy: ["bucket", "event"], interval: window.interval }),
        store.readCounters({
          ...base, events: ["provider_operation"],
          groupBy: ["connectionId", "providerModelId", "stage", "outcome", "action", "code", "reason", "httpStatus"]
        }),
        store.readCounters({
          ...base, events: ["tool_execution"], dimensions: { tool_kind: "vision" },
          groupBy: ["connectionId", "providerModelId", "outcome", "action", "code", "reason", "httpStatus"]
        })
      ]);

      const errorRows = totals.filter((row) => row.group.level === "error" || row.group.level === "fatal");
      const ofEvent = (event: string) => totals.filter((row) => row.group.event === event);
      const starts = new Map<string, number>();
      for (const row of ofEvent("process.started")) {
        const role = textValue(row.group.role);
        if (role) starts.set(role, (starts.get(role) ?? 0) + row.count);
      }
      const roleStarts: AdminHealthRoleStarts[] = [...starts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, value]) => ({ role, starts: value, restarts: Math.max(0, value - 1) }));

      const buckets = window.buckets.map((start) => ({ start, counts: emptyCategories() }));
      const bucketIndex = new Map(window.buckets.map((start, index) => [start.getTime(), index]));
      for (const row of series) {
        const start = row.group.bucket;
        const event = textValue(row.group.event);
        const index = start instanceof Date ? bucketIndex.get(start.getTime()) : undefined;
        if (index === undefined || event === null) continue;
        buckets[index]!.counts[adminHealthEventCategory(event)] += row.count;
      }

      const accumulators = new Map<string, ProviderAccumulator>();
      foldProviders(providerRows, null, accumulators);
      foldProviders(visionRows, "vision", accumulators);
      const names = await dependencies.providerNames({
        connectionIds: boundedIds([...accumulators.values()].map((entry) => entry.connectionId)),
        modelIds: boundedIds([...accumulators.values()].map((entry) => entry.providerModelId))
      });
      const providers = [...accumulators.entries()].map(([key, entry]): AdminHealthProviderRow => ({
        key,
        connectionId: entry.connectionId,
        ...connectionLabel(entry.connectionId, names),
        providerModelId: entry.providerModelId,
        modelName: modelLabel(entry.providerModelId, names),
        stage: entry.stage,
        operations: entry.operations,
        failures: entry.failures,
        failureRate: entry.operations > 0 ? entry.failures / entry.operations : null,
        failuresByClass: entry.failuresByClass,
        p95Ms: adminHealthP95(entry.buckets, entry.maxMs),
        lastFailureAt: entry.lastFailureAt === null ? null : new Date(entry.lastFailureAt).toISOString()
      })).sort(compareProviders);

      // Image analysis attempts are a separate stage; the summary rate counts provider operations only.
      const operationRows = providers.filter((row) => row.stage !== "vision");
      const providerOperations = operationRows.reduce((total, row) => total + row.operations, 0);
      const providerFailures = operationRows.reduce((total, row) => total + row.failures, 0);

      return {
        range,
        interval: window.interval,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        generatedAt: generatedAt.toISOString(),
        hasTelemetry: totals.length > 0,
        summary: {
          errors: sum(errorRows, (row) => row.count),
          previousErrors: previous === null ? null : sum(previous, (row) => row.count),
          providerOperations,
          providerFailures,
          providerFailureRate: providerOperations > 0 ? providerFailures / providerOperations : null,
          http5xx: sum(errorRows.filter((row) => row.group.event === "http.request_completed" ||
            row.group.event === "http.request_failed"), (row) => row.count),
          restarts: roleStarts.reduce((total, item) => total + item.restarts, 0),
          roleStarts,
          droppedLogRecords: sum(ofEvent("logging.dropped_records"), (row) => row.valueSum),
          clientErrors: sum(ofEvent("client.error"), (row) => row.count)
        },
        series: buckets.map((bucket) => ({
          start: bucket.start.toISOString(),
          counts: bucket.counts,
          total: adminHealthCategories.reduce((total, category) => total + bucket.counts[category], 0)
        })),
        providers,
        providersTruncated: providerRows.length >= ROW_LIMIT || visionRows.length >= ROW_LIMIT
      };
    },

    async incidents(filters: AdminHealthIncidentFilters): Promise<AdminHealthIncidentsResponse> {
      const reference = filters.q;
      const events = filters.event ? [filters.event]
        : filters.category ? [...ADMIN_HEALTH_CATEGORY_EVENTS[filters.category]] : undefined;
      if (filters.event && filters.category && !ADMIN_HEALTH_CATEGORY_EVENTS[filters.category].includes(filters.event)) {
        return { incidents: [], nextCursor: null };
      }
      const page = await store.readIncidents({
        from: adminHealthIncidentFrom(filters.range, now()),
        ...(events ? { events } : {}),
        ...(filters.code ? { codes: [filters.code] } : {}),
        ...(filters.level ? { levels: [filters.level] } : {}),
        ...(reference ? referenceFilter(reference) : {}),
        cursor: filters.cursor,
        limit: INCIDENT_PAGE
      });
      const modelOf = (details: Readonly<Record<string, string | number | boolean>>) =>
        typeof details.providerModelId === "string" ? details.providerModelId : null;
      const names = await dependencies.providerNames({
        connectionIds: boundedIds(page.items.map((item) => item.connectionId)),
        modelIds: boundedIds(page.items.map((item) => modelOf(item.details)))
      });
      const incidents = page.items.map((item): AdminHealthIncident => {
        const stage = item.details.stage;
        const status = item.details.httpStatus ?? (item.event.startsWith("http.") ? item.details.status : undefined);
        return {
          id: item.id,
          occurredAt: item.occurredAt.toISOString(),
          role: item.role,
          event: item.event,
          level: item.level,
          code: item.code,
          subsystem: item.subsystem,
          stage: typeof stage === "string" ? stage : null,
          connectionId: item.connectionId,
          connectionName: item.connectionId === null ? null : connectionLabel(item.connectionId, names).connectionName,
          modelName: modelLabel(modelOf(item.details), names),
          httpStatus: typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
          runId: item.runId,
          traceId: item.traceId,
          details: incidentDetails(item.details)
        };
      });
      return { incidents, nextCursor: page.nextCursor };
    }
  });
}
