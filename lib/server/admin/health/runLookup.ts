import { ADMIN_HEALTH_CODE_PATTERN, type AdminHealthErrorResponse } from "../../../contracts/adminHealth";
import {
  ADMIN_HEALTH_RUN_LOOKUP_LIMIT,
  adminHealthRunStatuses,
  parseAdminHealthRunLookupQuery,
  type AdminHealthRunLookupResponse,
  type AdminHealthRunStatus,
  type AdminHealthRunSummary
} from "../../../contracts/adminHealthRunLookup";
import { normalizeRunReference, RUN_ID_LENGTH } from "../../../contracts/runReference";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelemetryStore } from "../../telemetry/store";

/**
 * One chat run as the lookup reads it: lifecycle columns, the stable failure
 * code (never the message) and the answer binding's provider display names.
 * Name columns are `null` when the binding or the row it names is missing.
 */
export type AdminHealthRunRow = Readonly<{
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  failureCode: string | null;
  connectionId: string | null;
  connectionName: string | null;
  providerModelId: string | null;
  modelDisplayName: string | null;
  modelProviderId: string | null;
}>;

export type AdminHealthRunRepository = Readonly<{
  /** Runs whose id starts with the normalized reference, by id, at most `limit` rows. */
  findByReference(reference: string, limit: number): Promise<readonly AdminHealthRunRow[]>;
}>;

export type AdminHealthRunLookup = Readonly<{
  lookup(reference: string): Promise<AdminHealthRunLookupResponse>;
}>;

const SETTLED = new Set<AdminHealthRunStatus>(["complete", "cancelled", "error"]);
const DELETED_CONNECTION = "Deleted connection";
const DELETED_MODEL = "Deleted model";

export class AdminHealthRunReferenceError extends Error {
  constructor() {
    super("admin_health_run_reference_invalid");
    this.name = "AdminHealthRunReferenceError";
  }
}

function displayName(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function summary(row: AdminHealthRunRow, incidentCount: number): AdminHealthRunSummary | null {
  if (row.id.length !== RUN_ID_LENGTH || normalizeRunReference(row.id) !== row.id ||
    !(adminHealthRunStatuses as readonly string[]).includes(row.status)) return null;
  const status = row.status as AdminHealthRunStatus;
  const durationMs = row.updatedAt.getTime() - row.createdAt.getTime();
  return {
    runId: row.id,
    status,
    startedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    durationMs: SETTLED.has(status) ? Math.max(0, durationMs) : null,
    failureCode: row.failureCode !== null && ADMIN_HEALTH_CODE_PATTERN.test(row.failureCode) ? row.failureCode : null,
    connectionName: row.connectionId === null ? null
      : displayName(row.connectionName) ?? (row.connectionName === null ? DELETED_CONNECTION : "Unnamed connection"),
    modelName: row.providerModelId === null ? null
      : displayName(row.modelDisplayName) ?? displayName(row.modelProviderId) ?? DELETED_MODEL,
    incidentCount
  };
}

/**
 * Looks a run up by its error reference for an administrator: a bounded,
 * id-ordered prefix match returning content-free summaries and the number of
 * retained incidents linked to each run.
 */
export function createAdminHealthRunLookup(dependencies: Readonly<{
  runs: AdminHealthRunRepository;
  incidents: Pick<TelemetryStore, "countIncidentsByRun">;
}>): AdminHealthRunLookup {
  return Object.freeze({
    async lookup(value: string): Promise<AdminHealthRunLookupResponse> {
      const reference = normalizeRunReference(value);
      if (reference === null) throw new AdminHealthRunReferenceError();
      const rows = await dependencies.runs.findByReference(reference, ADMIN_HEALTH_RUN_LOOKUP_LIMIT + 1);
      const selected = rows.filter((row) => row.id.startsWith(reference)).slice(0, ADMIN_HEALTH_RUN_LOOKUP_LIMIT);
      const counts = selected.length > 0
        ? await dependencies.incidents.countIncidentsByRun(selected.map((row) => row.id))
        : new Map<string, number>();
      const runs = selected
        .map((row) => summary(row, counts.get(row.id) ?? 0))
        .filter((run): run is AdminHealthRunSummary => run !== null);
      return { runs, truncated: rows.length > ADMIN_HEALTH_RUN_LOOKUP_LIMIT };
    }
  });
}

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

function json(body: AdminHealthRunLookupResponse | AdminHealthErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

/** GET /api/admin/health/runs?q=<error reference or run id> — active administrators only. */
export function createAdminHealthRunLookupHandler(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  lookup: AdminHealthRunLookup;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
    const reference = parseAdminHealthRunLookupQuery(new URL(request.url).searchParams);
    if (reference === null) return json({ error: "admin_health_query_invalid" }, 400);
    try {
      return json(await input.lookup.lookup(reference));
    } catch (error) {
      if (error instanceof AdminHealthRunReferenceError) return json({ error: "admin_health_query_invalid" }, 400);
      logEvent("service_operation", { error, subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "admin_health_failed" }, 503);
    }
  };
}
