import { ADMIN_HEALTH_CODE_PATTERN } from "./adminHealth";
import { normalizeRunReference, RUN_ID_LENGTH } from "./runReference";

/**
 * Control Center Health run lookup: the content-free summary of the chat runs
 * whose id starts with an error reference. It carries status, times, the
 * stable failure code, provider display names and the linked incident count,
 * never prompts, answers, chat titles, error messages or user identity.
 */
export const ADMIN_HEALTH_RUN_LOOKUP_LIMIT = 5;

export const adminHealthRunStatuses = ["preparing", "queued", "streaming", "in_progress", "complete", "cancelled", "error"] as const;
export type AdminHealthRunStatus = (typeof adminHealthRunStatuses)[number];

export type AdminHealthRunSummary = {
  runId: string;
  status: AdminHealthRunStatus;
  startedAt: string;
  /** Last change of the run; its settlement time once it is complete, cancelled or failed. */
  updatedAt: string;
  /** Start to settlement; `null` while the run is still active. */
  durationMs: number | null;
  failureCode: string | null;
  /** `null` when the run has no answer provider binding. */
  connectionName: string | null;
  modelName: string | null;
  /** Retained telemetry incidents carrying this run id. */
  incidentCount: number;
};

export type AdminHealthRunLookupResponse = {
  runs: AdminHealthRunSummary[];
  /** More runs share this reference than the lookup returns. */
  truncated: boolean;
};

/** The single `q` value of a lookup, normalized, or `null` when it is not a run reference. */
export function parseAdminHealthRunLookupQuery(params: URLSearchParams): string | null {
  const values = params.getAll("q");
  return values.length === 1 ? normalizeRunReference(values[0]!) : null;
}

export function adminHealthRunLookupSearch(reference: string): string {
  return new URLSearchParams({ q: reference }).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function time(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function name(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 300 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeRun(value: unknown): AdminHealthRunSummary | null {
  if (!isRecord(value) || typeof value.runId !== "string" || value.runId.length !== RUN_ID_LENGTH ||
    normalizeRunReference(value.runId) !== value.runId ||
    !(adminHealthRunStatuses as readonly unknown[]).includes(value.status) || !time(value.startedAt) || !time(value.updatedAt) ||
    !(value.durationMs === null || count(value.durationMs)) ||
    !(value.failureCode === null || typeof value.failureCode === "string" && ADMIN_HEALTH_CODE_PATTERN.test(value.failureCode)) ||
    !name(value.connectionName) || !name(value.modelName) || !count(value.incidentCount)) return null;
  return {
    runId: value.runId, status: value.status as AdminHealthRunStatus, startedAt: value.startedAt, updatedAt: value.updatedAt,
    durationMs: value.durationMs, failureCode: value.failureCode, connectionName: value.connectionName,
    modelName: value.modelName, incidentCount: value.incidentCount
  };
}

export function decodeAdminHealthRunLookupResponse(value: unknown): AdminHealthRunLookupResponse | null {
  if (!isRecord(value) || typeof value.truncated !== "boolean" || !Array.isArray(value.runs) ||
    value.runs.length > ADMIN_HEALTH_RUN_LOOKUP_LIMIT) return null;
  const runs = value.runs.map(decodeRun);
  return runs.every((run) => run !== null) ? { runs: runs as AdminHealthRunSummary[], truncated: value.truncated } : null;
}
