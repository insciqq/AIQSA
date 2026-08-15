export type ProviderStreamSafetyCode =
  | "provider_output_too_large"
  | "provider_stream_deadline_exceeded"
  | "provider_stream_event_too_large"
  | "provider_stream_timeout"
  | "provider_stream_too_large";

export type ProviderStreamTermination =
  | "absolute_deadline"
  | "event_limit"
  | "idle_timeout"
  | "normal"
  | "output_limit"
  | "total_limit"
  | "user_cancelled";

export type ProviderStreamSafetyUnit = "bytes" | "characters" | "milliseconds";

export type ProviderStreamSafetySnapshot = Readonly<{
  durationMs: number;
  totalStreamBytes: number;
}>;

export type ProviderStreamSafetyReport = Readonly<{
  code: ProviderStreamSafetyCode;
  durationMs: number;
  limit: number;
  message: string;
  observed: number;
  termination: ProviderStreamTermination;
  totalStreamBytes: number;
  unit: ProviderStreamSafetyUnit;
}>;

export type ProviderRetainedTextKind =
  | "citations"
  | "reasoning"
  | "signature"
  | "thinking"
  | "tool_arguments"
  | "visible_output";

type ProviderStreamSafetyErrorInput = Readonly<{
  code: ProviderStreamSafetyCode;
  limit: number;
  observed: number;
  snapshot?: ProviderStreamSafetySnapshot;
  termination: ProviderStreamTermination;
  unit: ProviderStreamSafetyUnit;
}>;

const streamSafetySnapshot = Symbol("providerStreamSafetySnapshot");

const safetyDescriptors = Object.freeze({
  provider_output_too_large: {
    termination: "output_limit",
    unit: "characters"
  },
  provider_stream_deadline_exceeded: {
    termination: "absolute_deadline",
    unit: "milliseconds"
  },
  provider_stream_event_too_large: {
    termination: "event_limit",
    unit: "bytes"
  },
  provider_stream_timeout: {
    termination: "idle_timeout",
    unit: "milliseconds"
  },
  provider_stream_too_large: {
    termination: "total_limit",
    unit: "bytes"
  }
} as const satisfies Record<ProviderStreamSafetyCode, {
  termination: ProviderStreamTermination;
  unit: ProviderStreamSafetyUnit;
}>);

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function snapshotValue(
  snapshot: ProviderStreamSafetySnapshot | undefined
): ProviderStreamSafetySnapshot {
  return Object.freeze({
    durationMs: finiteNonNegative(snapshot?.durationMs),
    totalStreamBytes: finiteNonNegative(snapshot?.totalStreamBytes)
  });
}

export function providerStreamSafeMessage(code: ProviderStreamSafetyCode): string {
  return code === "provider_stream_timeout"
    ? "The provider stream timed out."
    : "The provider stream exceeded a safety limit.";
}

export class ProviderStreamSafetyError extends Error {
  readonly code: ProviderStreamSafetyCode;
  readonly durationMs: number;
  readonly limit: number;
  readonly observed: number;
  readonly report: ProviderStreamSafetyReport;
  readonly safeMessage: string;
  readonly termination: ProviderStreamTermination;
  readonly totalStreamBytes: number;
  readonly unit: ProviderStreamSafetyUnit;

  protected constructor(input: ProviderStreamSafetyErrorInput) {
    super(input.code);
    this.name = "ProviderStreamSafetyError";
    this.code = input.code;
    this.termination = input.termination;
    this.unit = input.unit;
    this.limit = input.limit;
    this.observed = input.observed;

    const snapshot = snapshotValue(input.snapshot);
    this.totalStreamBytes = snapshot.totalStreamBytes;
    this.durationMs = snapshot.durationMs;
    this.safeMessage = providerStreamSafeMessage(input.code);
    this.report = Object.freeze({
      code: this.code,
      durationMs: this.durationMs,
      limit: this.limit,
      message: this.safeMessage,
      observed: this.observed,
      termination: this.termination,
      totalStreamBytes: this.totalStreamBytes,
      unit: this.unit
    });
  }
}

export class ProviderStreamEventTooLargeError extends ProviderStreamSafetyError {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: Readonly<{
    maxBytes: number;
    observedBytes: number;
    snapshot?: ProviderStreamSafetySnapshot;
  }>) {
    super({
      code: "provider_stream_event_too_large",
      limit: input.maxBytes,
      observed: input.observedBytes,
      snapshot: input.snapshot,
      termination: "event_limit",
      unit: "bytes"
    });
    this.name = "ProviderStreamEventTooLargeError";
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

export class ProviderStreamTooLargeError extends ProviderStreamSafetyError {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: Readonly<{
    maxBytes: number;
    observedBytes: number;
    snapshot?: ProviderStreamSafetySnapshot;
  }>) {
    super({
      code: "provider_stream_too_large",
      limit: input.maxBytes,
      observed: input.observedBytes,
      snapshot: input.snapshot,
      termination: "total_limit",
      unit: "bytes"
    });
    this.name = "ProviderStreamTooLargeError";
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

export class ProviderStreamDeadlineExceededError extends ProviderStreamSafetyError {
  readonly maxDurationMs: number;
  readonly observedDurationMs: number;

  constructor(input: Readonly<{
    maxDurationMs: number;
    observedDurationMs: number;
    snapshot?: ProviderStreamSafetySnapshot;
  }>) {
    super({
      code: "provider_stream_deadline_exceeded",
      limit: input.maxDurationMs,
      observed: input.observedDurationMs,
      snapshot: input.snapshot,
      termination: "absolute_deadline",
      unit: "milliseconds"
    });
    this.name = "ProviderStreamDeadlineExceededError";
    this.maxDurationMs = input.maxDurationMs;
    this.observedDurationMs = input.observedDurationMs;
  }
}

export class ProviderStreamIdleTimeoutError extends ProviderStreamSafetyError {
  readonly idleTimeoutMs: number;
  readonly observedIdleMs: number;

  constructor(input: Readonly<{
    idleTimeoutMs: number;
    observedIdleMs: number;
    snapshot?: ProviderStreamSafetySnapshot;
  }>) {
    super({
      code: "provider_stream_timeout",
      limit: input.idleTimeoutMs,
      observed: input.observedIdleMs,
      snapshot: input.snapshot,
      termination: "idle_timeout",
      unit: "milliseconds"
    });
    this.name = "ProviderStreamIdleTimeoutError";
    this.idleTimeoutMs = input.idleTimeoutMs;
    this.observedIdleMs = input.observedIdleMs;
  }
}

export class ProviderOutputTooLargeError extends ProviderStreamSafetyError {
  readonly maxChars: number;
  readonly observedChars: number;
  readonly retainedTextKind: ProviderRetainedTextKind;

  constructor(input: Readonly<{
    maxChars: number;
    observedChars: number;
    retainedTextKind: ProviderRetainedTextKind;
    snapshot?: ProviderStreamSafetySnapshot;
  }>) {
    super({
      code: "provider_output_too_large",
      limit: input.maxChars,
      observed: input.observedChars,
      snapshot: input.snapshot,
      termination: "output_limit",
      unit: "characters"
    });
    this.name = "ProviderOutputTooLargeError";
    this.maxChars = input.maxChars;
    this.observedChars = input.observedChars;
    this.retainedTextKind = input.retainedTextKind;
  }
}

export function isProviderStreamSafetyCode(value: unknown): value is ProviderStreamSafetyCode {
  return value === "provider_output_too_large"
    || value === "provider_stream_deadline_exceeded"
    || value === "provider_stream_event_too_large"
    || value === "provider_stream_timeout"
    || value === "provider_stream_too_large";
}

function isSafetyReport(value: unknown): value is ProviderStreamSafetyReport {
  if (!value || typeof value !== "object") {
    return false;
  }

  const report = value as Partial<ProviderStreamSafetyReport>;
  if (!isProviderStreamSafetyCode(report.code)) {
    return false;
  }
  const descriptor = safetyDescriptors[report.code];
  return isProviderStreamSafetyCode(report.code)
    && typeof report.durationMs === "number"
    && Number.isFinite(report.durationMs)
    && report.durationMs >= 0
    && typeof report.limit === "number"
    && Number.isSafeInteger(report.limit)
    && report.limit > 0
    && report.message === providerStreamSafeMessage(report.code)
    && typeof report.observed === "number"
    && Number.isFinite(report.observed)
    && report.observed >= 0
    && (descriptor.unit === "milliseconds" || Number.isSafeInteger(report.observed))
    && report.termination === descriptor.termination
    && typeof report.totalStreamBytes === "number"
    && Number.isSafeInteger(report.totalStreamBytes)
    && report.totalStreamBytes >= 0
    && report.unit === descriptor.unit;
}

export function providerStreamSafetyReport(value: unknown): ProviderStreamSafetyReport | null {
  if (value instanceof ProviderStreamSafetyError) {
    return isSafetyReport(value.report) ? value.report : null;
  }
  if (value && typeof value === "object" && isSafetyReport(
    (value as { report?: unknown }).report
  )) {
    return (value as { report: ProviderStreamSafetyReport }).report;
  }
  return isSafetyReport(value) ? value : null;
}

export function attachProviderStreamSafetySnapshot<T extends object>(
  value: T,
  snapshot: ProviderStreamSafetySnapshot
): T {
  Object.defineProperty(value, streamSafetySnapshot, {
    configurable: false,
    enumerable: false,
    value: snapshotValue(snapshot),
    writable: false
  });
  return value;
}

export function providerStreamSafetySnapshot(
  value: unknown
): ProviderStreamSafetySnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = (value as { [streamSafetySnapshot]?: unknown })[streamSafetySnapshot];
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const candidate = snapshot as Partial<ProviderStreamSafetySnapshot>;
  return typeof candidate.durationMs === "number"
    && Number.isFinite(candidate.durationMs)
    && candidate.durationMs >= 0
    && typeof candidate.totalStreamBytes === "number"
    && Number.isSafeInteger(candidate.totalStreamBytes)
    && candidate.totalStreamBytes >= 0
    ? candidate as ProviderStreamSafetySnapshot
    : null;
}
