import {
  ADMIN_HEALTH_PROBLEM_REPORT_LIMIT,
  type AdminHealthProblemReport,
  type AdminHealthProblemReports,
  type AdminHealthProblemReportsErrorResponse,
  type AdminHealthProblemReportsResponse
} from "../../../contracts/adminHealthProblemReports";
import { defaultAdminHealthRange, isAdminHealthRange } from "../../../contracts/adminHealth";
import { normalizeRunReference, RUN_ID_LENGTH } from "../../../contracts/runReference";
import type { AnswerProblemReportListRow } from "../../answerProblemReports/repository";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { adminHealthIncidentFrom } from "./projection";

export type AdminHealthProblemReportsReader = (input: Readonly<{ from: Date; limit: number }>) =>
  Promise<Readonly<{ rows: readonly AnswerProblemReportListRow[]; total: number }>>;

/** One report as the Health list shows it: the run only when it is a well-formed run id. */
export function projectAdminHealthProblemReport(row: AnswerProblemReportListRow): AdminHealthProblemReport {
  const runId = row.runId !== null && row.runId.length === RUN_ID_LENGTH && normalizeRunReference(row.runId) === row.runId
    ? row.runId : null;
  return {
    comment: row.comment,
    connectionName: row.connectionName,
    id: row.id,
    modelName: row.modelName,
    reason: row.reason,
    reportedAt: row.updatedAt.toISOString(),
    runId,
    user: { displayName: row.user.displayName, email: row.user.email, id: row.user.id }
  };
}

function json(body: AdminHealthProblemReportsResponse | AdminHealthProblemReportsErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("vary", "Cookie");
  return response;
}

/**
 * `GET /api/admin/health/problem-reports?range=24h|7d|14d|30d`: the answer
 * problem reports sent or updated in the range, newest first and bounded,
 * for active administrators only. Rows never carry the chat or its content.
 */
export function createAdminHealthProblemReportsHandler(input: Readonly<{
  now?: () => Date;
  read: AdminHealthProblemReportsReader;
  resolveAuth: RequestAuthResolver;
}>) {
  const clock = input.now ?? (() => new Date());
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
    const values = new URL(request.url).searchParams.getAll("range");
    const range = values.length === 0 ? defaultAdminHealthRange : values.length === 1 ? values[0] : null;
    if (!isAdminHealthRange(range)) return json({ error: "admin_health_query_invalid" }, 400);
    const now = clock();
    const from = adminHealthIncidentFrom(range, now);
    try {
      const { rows, total } = await input.read({ from, limit: ADMIN_HEALTH_PROBLEM_REPORT_LIMIT });
      const reports = rows.slice(0, ADMIN_HEALTH_PROBLEM_REPORT_LIMIT).map(projectAdminHealthProblemReport);
      const page: AdminHealthProblemReports = {
        from: from.toISOString(), generatedAt: now.toISOString(), range, reports, total: Math.max(total, reports.length),
        truncated: total > reports.length
      };
      return json({ problemReports: page });
    } catch (error) {
      logEvent("service_operation", { error, subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "admin_health_failed" }, 503);
    }
  };
}
