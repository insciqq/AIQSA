import { isAdminHealthRange, type AdminHealthRange } from "./adminHealth";
import {
  ANSWER_PROBLEM_REPORT_COMMENT_MAX,
  isAnswerProblemReason,
  type AnswerProblemReason
} from "./answerProblemReports";
import type { ErrorResponse } from "./http";

/**
 * Control Center Health "Problem reports": the answer problem reports users
 * sent or updated in the selected range, newest first and bounded. A row
 * names the reporting user as the user list does, the answer's model and
 * provider connection and its run (for the run lookup), never the chat, the
 * question or the answer.
 */
export const ADMIN_HEALTH_PROBLEM_REPORT_LIMIT = 100;

export type AdminHealthProblemReport = {
  id: string;
  /** When the user last sent it. */
  reportedAt: string;
  reason: AnswerProblemReason;
  /** The user's own words, written for administrators. */
  comment: string | null;
  user: { id: string; displayName: string; email: string | null };
  /** The answer's provider connection and model; null when the answer had no recorded run. */
  connectionName: string | null;
  modelName: string | null;
  /** The answer's run, for the run lookup; null when it had none or it was deleted. */
  runId: string | null;
};

export type AdminHealthProblemReports = {
  range: AdminHealthRange;
  from: string;
  generatedAt: string;
  /** Reports in the range, of which the newest `reports.length` are listed. */
  total: number;
  truncated: boolean;
  reports: AdminHealthProblemReport[];
};

export type AdminHealthProblemReportsResponse = { problemReports: AdminHealthProblemReports };
export type AdminHealthProblemReportsErrorResponse = ErrorResponse<
  "unauthorized" | "forbidden" | "admin_health_query_invalid" | "admin_health_failed"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nullableText(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= max);
}

function decodeReport(value: unknown): AdminHealthProblemReport | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isTime(value.reportedAt) || !isAnswerProblemReason(value.reason) ||
    !nullableText(value.comment, ANSWER_PROBLEM_REPORT_COMMENT_MAX) || !nullableText(value.connectionName, 300) ||
    !nullableText(value.modelName, 300) || !nullableText(value.runId, 64) || !isRecord(value.user)) return null;
  const user = value.user;
  if (typeof user.id !== "string" || typeof user.displayName !== "string" || !nullableText(user.email, 320)) return null;
  return {
    comment: value.comment,
    connectionName: value.connectionName,
    id: value.id,
    modelName: value.modelName,
    reason: value.reason,
    reportedAt: value.reportedAt,
    runId: value.runId,
    user: { displayName: user.displayName, email: user.email, id: user.id }
  };
}

export function decodeAdminHealthProblemReportsResponse(value: unknown): AdminHealthProblemReportsResponse | null {
  if (!isRecord(value) || !isRecord(value.problemReports)) return null;
  const page = value.problemReports;
  if (!isAdminHealthRange(page.range) || !isTime(page.from) || !isTime(page.generatedAt) ||
    typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0 ||
    typeof page.truncated !== "boolean" || !Array.isArray(page.reports) ||
    page.reports.length > ADMIN_HEALTH_PROBLEM_REPORT_LIMIT) return null;
  const reports: AdminHealthProblemReport[] = [];
  for (const entry of page.reports) {
    const report = decodeReport(entry);
    if (!report) return null;
    reports.push(report);
  }
  return { problemReports: { from: page.from, generatedAt: page.generatedAt, range: page.range, reports,
    total: page.total, truncated: page.truncated } };
}
