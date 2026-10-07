/**
 * Pure, bounded aggregation of validated log records into hourly counters and
 * a small set of recent error incidents. It holds only content-free fields the
 * observability leaf already validated, and never ids as counter dimensions.
 */

export const TELEMETRY_LEVELS = Object.freeze(["info", "warn", "error", "fatal"] as const);
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];
export type TelemetryIncidentLevel = Extract<TelemetryLevel, "error" | "fatal">;

/** The only record fields that become counter dimensions: bounded enumerations,
 * codes, statuses and installation-level identities. Never run, job, trace or
 * tool-call ids, counts, durations, timestamps, attempts, bytes or limits. */
export const TELEMETRY_DIMENSIONS = Object.freeze([
  "abort_source", "action", "adapterKind", "category", "cause", "code", "connectionId", "error_category",
  "error_class", "error_fingerprint", "error_site",
  "httpStatus", "kind", "layer", "method", "mode", "operation", "outcome", "prisma_code", "providerFamily",
  "providerModelId", "provider_code", "provider_status", "reason", "routePath", "stage", "state", "status",
  "subsystem", "termination", "tool_kind", "transport", "work_stage"
] as const);
export type TelemetryDimension = (typeof TELEMETRY_DIMENSIONS)[number];
export type TelemetryDimensionValue = string | number | boolean;
export type TelemetryDimensions = Readonly<Record<string, TelemetryDimensionValue>>;

/** Dimensions of the per-event key that absorbs observations once the pending
 * key bound is reached; readers see these totals without their dimensions. */
export const TELEMETRY_OVERFLOW_DIMENSIONS: TelemetryDimensions = Object.freeze({ overflow: true });

/** Upper bounds (inclusive, ms) of the fixed duration histogram; the last
 * bucket counts everything above the last bound. */
export const TELEMETRY_DURATION_BOUNDS_MS = Object.freeze(
  [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000] as const
);
export const TELEMETRY_DURATION_BUCKETS = TELEMETRY_DURATION_BOUNDS_MS.length + 1;

export type TelemetryCounterDelta = Readonly<{
  bucketStart: Date;
  role: string;
  event: string;
  level: TelemetryLevel;
  appVersion: string;
  dimensions: TelemetryDimensions;
  count: number;
  /** Sum of the records' numeric `count` field, e.g. lines a dropped-records report lost. */
  valueSum: number;
  durationCount: number;
  durationSumMs: number;
  durationMaxMs: number | null;
  durationBuckets: readonly number[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}>;

export type TelemetryIncidentInput = Readonly<{
  occurredAt: Date;
  role: string;
  event: string;
  level: TelemetryIncidentLevel;
  appVersion: string;
  instanceId: string;
  code: string | null;
  subsystem: string | null;
  connectionId: string | null;
  runId: string | null;
  traceId: string | null;
  /** The rest of the validated record. */
  details: Readonly<Record<string, string | number | boolean>>;
}>;

export type TelemetryBatch = Readonly<{
  counters: readonly TelemetryCounterDelta[];
  incidents: readonly TelemetryIncidentInput[];
  /** Observations dropped because even their overflow key found no room. */
  lostObservations: number;
}>;

export type TelemetryAggregatorLimits = Readonly<{
  maxCounterKeys: number;
  maxOverflowKeys: number;
  maxIncidents: number;
  incidentsPerMinute: number;
  maxIncidentKeys: number;
}>;

export const DEFAULT_TELEMETRY_AGGREGATOR_LIMITS: TelemetryAggregatorLimits = Object.freeze({
  maxCounterKeys: 2_000,
  maxOverflowKeys: 500,
  maxIncidents: 200,
  incidentsPerMinute: 10,
  maxIncidentKeys: 1_000
});

export type TelemetryAggregator = Readonly<{
  observe(record: unknown): void;
  /** Takes everything pending; the caller writes it or hands it back. */
  drain(): TelemetryBatch;
  /** Merges a batch whose write failed back into the pending state, within bounds. */
  restore(batch: TelemetryBatch): void;
  pending(): Readonly<{ counters: number; incidents: number }>;
}>;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
// Beyond these a value is a defect, never a measurement; dropping it keeps
// one malformed record from failing every later write of its batch.
const MAX_DURATION_MS = 10_000_000_000;
const MAX_RECORD_COUNT = 2_147_483_647;
const printable = /^[\x20-\x7e]+$/u;
const SEPARATOR = "\u0000";
const levels = new Set<unknown>(TELEMETRY_LEVELS);
const dimensionOrder = [...TELEMETRY_DIMENSIONS].sort();
const incidentColumns = new Set([
  "timestamp", "level", "event", "role", "app_version", "instance_id",
  "code", "subsystem", "connectionId", "run_id", "trace_id"
]);

type Entry = {
  bucketStart: number;
  role: string;
  event: string;
  level: TelemetryLevel;
  appVersion: string;
  dimensions: TelemetryDimensions;
  dimensionsJson: string;
  overflow: boolean;
  count: number;
  valueSum: number;
  durationCount: number;
  durationSumMs: number;
  durationMaxMs: number | null;
  durationBuckets: number[];
  firstSeenAt: number;
  lastSeenAt: number;
};

type ParsedRecord = Readonly<{
  source: object;
  time: number;
  level: TelemetryLevel;
  event: string;
  role: string;
  appVersion: string;
}>;

/** One canonical text per dimension set: sorted keys, JSON values. */
export function telemetryDimensionsJson(dimensions: TelemetryDimensions): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(dimensions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  ));
}

export function telemetryDurationBucket(durationMs: number): number {
  const index = TELEMETRY_DURATION_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
  return index === -1 ? TELEMETRY_DURATION_BOUNDS_MS.length : index;
}

function own(source: object, key: string): unknown {
  return Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && printable.test(value) ? value : null;
}

function parseRecord(input: unknown): ParsedRecord | null {
  if (!input || typeof input !== "object") return null;
  const timestamp = own(input, "timestamp");
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const level = own(input, "level");
  const event = text(own(input, "event"), 64);
  const role = text(own(input, "role"), 32);
  const appVersion = text(own(input, "app_version"), 64);
  if (!Number.isFinite(time) || !levels.has(level) || !event || !role || !appVersion) return null;
  return { source: input, time, level: level as TelemetryLevel, event, role, appVersion };
}

function recordDimensions(source: object): TelemetryDimensions {
  const dimensions: Record<string, string | number> = {};
  for (const key of dimensionOrder) {
    const value = own(source, key);
    if (text(value, 512) !== null || typeof value === "number" && Number.isSafeInteger(value)) {
      dimensions[key] = value as string | number;
    }
  }
  return Object.freeze(dimensions);
}

function entryFromRecord(record: ParsedRecord): Entry {
  const dimensions = recordDimensions(record.source);
  const value = own(record.source, "count");
  const duration = own(record.source, "duration_ms");
  const timed = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= MAX_DURATION_MS;
  const durationBuckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  if (timed) durationBuckets[telemetryDurationBucket(duration)] = 1;
  return {
    bucketStart: Math.floor(record.time / HOUR_MS) * HOUR_MS,
    role: record.role,
    event: record.event,
    level: record.level,
    appVersion: record.appVersion,
    dimensions,
    dimensionsJson: telemetryDimensionsJson(dimensions),
    overflow: false,
    count: 1,
    valueSum: typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECORD_COUNT ? value : 0,
    durationCount: timed ? 1 : 0,
    durationSumMs: timed ? duration : 0,
    durationMaxMs: timed ? duration : null,
    durationBuckets,
    firstSeenAt: record.time,
    lastSeenAt: record.time
  };
}

function entryFromDelta(delta: TelemetryCounterDelta): Entry {
  const overflow = delta.dimensions.overflow === true;
  const dimensions = overflow ? TELEMETRY_OVERFLOW_DIMENSIONS : delta.dimensions;
  return {
    bucketStart: delta.bucketStart.getTime(),
    role: delta.role,
    event: delta.event,
    level: delta.level,
    appVersion: delta.appVersion,
    dimensions,
    dimensionsJson: telemetryDimensionsJson(dimensions),
    overflow,
    count: delta.count,
    valueSum: delta.valueSum,
    durationCount: delta.durationCount,
    durationSumMs: delta.durationSumMs,
    durationMaxMs: delta.durationMaxMs,
    durationBuckets: Array.from({ length: TELEMETRY_DURATION_BUCKETS }, (_, index) => delta.durationBuckets[index] ?? 0),
    firstSeenAt: delta.firstSeenAt.getTime(),
    lastSeenAt: delta.lastSeenAt.getTime()
  };
}

function overflowEntry(entry: Entry): Entry {
  return {
    ...entry,
    dimensions: TELEMETRY_OVERFLOW_DIMENSIONS,
    dimensionsJson: telemetryDimensionsJson(TELEMETRY_OVERFLOW_DIMENSIONS),
    overflow: true,
    durationBuckets: [...entry.durationBuckets]
  };
}

function keyOf(entry: Entry): string {
  return [entry.bucketStart, entry.role, entry.event, entry.level, entry.appVersion, entry.dimensionsJson].join(SEPARATOR);
}

function combine(target: Entry, source: Entry): void {
  target.count += source.count;
  target.valueSum += source.valueSum;
  target.durationCount += source.durationCount;
  target.durationSumMs += source.durationSumMs;
  target.durationMaxMs = source.durationMaxMs === null ? target.durationMaxMs
    : target.durationMaxMs === null ? source.durationMaxMs : Math.max(target.durationMaxMs, source.durationMaxMs);
  for (let index = 0; index < TELEMETRY_DURATION_BUCKETS; index += 1) {
    target.durationBuckets[index] = (target.durationBuckets[index] ?? 0) + (source.durationBuckets[index] ?? 0);
  }
  target.firstSeenAt = Math.min(target.firstSeenAt, source.firstSeenAt);
  target.lastSeenAt = Math.max(target.lastSeenAt, source.lastSeenAt);
}

function toDelta(entry: Entry): TelemetryCounterDelta {
  return Object.freeze({
    bucketStart: new Date(entry.bucketStart),
    role: entry.role,
    event: entry.event,
    level: entry.level,
    appVersion: entry.appVersion,
    dimensions: entry.dimensions,
    count: entry.count,
    valueSum: entry.valueSum,
    durationCount: entry.durationCount,
    durationSumMs: entry.durationSumMs,
    durationMaxMs: entry.durationMaxMs,
    durationBuckets: Object.freeze([...entry.durationBuckets]),
    firstSeenAt: new Date(entry.firstSeenAt),
    lastSeenAt: new Date(entry.lastSeenAt)
  });
}

function incidentFrom(record: ParsedRecord): TelemetryIncidentInput | null {
  const instanceId = own(record.source, "instance_id");
  if (typeof instanceId !== "string" || !/^[0-9a-f]{32}$/u.test(instanceId)) return null;
  const traceId = own(record.source, "trace_id");
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record.source)) {
    if (incidentColumns.has(key) || text(key, 64) === null) continue;
    if (text(value, 512) !== null || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)) details[key] = value as string | number | boolean;
  }
  return Object.freeze({
    occurredAt: new Date(record.time),
    role: record.role,
    event: record.event,
    level: record.level as TelemetryIncidentLevel,
    appVersion: record.appVersion,
    instanceId,
    code: text(own(record.source, "code"), 128),
    subsystem: text(own(record.source, "subsystem"), 64),
    connectionId: text(own(record.source, "connectionId"), 128),
    runId: text(own(record.source, "run_id"), 128),
    traceId: typeof traceId === "string" && /^[0-9a-f]{32}$/u.test(traceId) ? traceId : null,
    details: Object.freeze(details)
  });
}

export function createTelemetryAggregator(
  limits: TelemetryAggregatorLimits = DEFAULT_TELEMETRY_AGGREGATOR_LIMITS
): TelemetryAggregator {
  let counters = new Map<string, Entry>();
  let regularKeys = 0;
  let overflowKeys = 0;
  let incidents: TelemetryIncidentInput[] = [];
  let lost = 0;
  // Per-key admissions in the current minute; suppressed incidents stay counted.
  const admissions = new Map<string, { minute: number; admitted: number }>();

  const add = (entry: Entry): void => {
    const key = keyOf(entry);
    const existing = counters.get(key);
    if (existing) {
      combine(existing, entry);
    } else if (!entry.overflow && regularKeys < limits.maxCounterKeys) {
      counters.set(key, entry);
      regularKeys += 1;
    } else {
      const folded = entry.overflow ? entry : overflowEntry(entry);
      const foldedKey = keyOf(folded);
      const target = counters.get(foldedKey);
      if (target) {
        combine(target, folded);
      } else if (overflowKeys < limits.maxOverflowKeys) {
        counters.set(foldedKey, folded);
        overflowKeys += 1;
      } else {
        lost += entry.count;
      }
    }
  };

  const admitIncident = (record: ParsedRecord): void => {
    if (incidents.length >= limits.maxIncidents) return;
    const key = ["code", "subsystem", "connectionId"]
      .reduce((value, field) => `${value}${SEPARATOR}${String(own(record.source, field) ?? "")}`, record.event);
    const minute = Math.floor(record.time / MINUTE_MS);
    let state = admissions.get(key);
    if (!state || state.minute !== minute) {
      if (!state && admissions.size >= limits.maxIncidentKeys) {
        for (const [stale, value] of admissions) if (value.minute < minute) admissions.delete(stale);
        if (admissions.size >= limits.maxIncidentKeys) return;
      }
      state = { minute, admitted: 0 };
      admissions.set(key, state);
    }
    if (state.admitted >= limits.incidentsPerMinute) return;
    const incident = incidentFrom(record);
    if (!incident) return;
    state.admitted += 1;
    incidents.push(incident);
  };

  return Object.freeze({
    observe(input: unknown): void {
      try {
        const record = parseRecord(input);
        if (!record) return;
        add(entryFromRecord(record));
        if (record.level === "error" || record.level === "fatal") admitIncident(record);
      } catch { /* A malformed record is skipped; the caller's logging is unaffected. */ }
    },
    drain(): TelemetryBatch {
      const batch: TelemetryBatch = Object.freeze({
        counters: Object.freeze([...counters.values()].map(toDelta)),
        incidents: Object.freeze(incidents),
        lostObservations: lost
      });
      counters = new Map();
      regularKeys = 0;
      overflowKeys = 0;
      incidents = [];
      lost = 0;
      return batch;
    },
    restore(batch: TelemetryBatch): void {
      for (const delta of batch.counters) add(entryFromDelta(delta));
      incidents = [...batch.incidents, ...incidents].slice(0, limits.maxIncidents);
    },
    pending() {
      return { counters: counters.size, incidents: incidents.length };
    }
  });
}
