import type { ErrorResponse } from "./http";

/**
 * "Report a problem…" on an answer: a signed-in user tells administrators
 * that a persisted answer went wrong. A report holds one reason and an
 * optional comment administrators read in Control Center Health; the
 * question and the answer are never attached. One report per user and
 * answer: sending again updates it.
 */
export const answerProblemReasons = [
  "wrong_or_made_up",
  "did_not_follow_request",
  "error_or_broken",
  "too_slow",
  "other"
] as const;
export type AnswerProblemReason = (typeof answerProblemReasons)[number];

export const answerProblemReasonLabels: Readonly<Record<AnswerProblemReason, string>> = {
  wrong_or_made_up: "Wrong or made-up answer",
  did_not_follow_request: "Didn't do what I asked",
  error_or_broken: "Error or something broken",
  too_slow: "Too slow",
  other: "Other"
};

/** UTF-16 code units, as a textarea's `maxLength` counts them. */
export const ANSWER_PROBLEM_REPORT_COMMENT_MAX = 1_000;

export function isAnswerProblemReason(value: unknown): value is AnswerProblemReason {
  return typeof value === "string" && (answerProblemReasons as readonly string[]).includes(value);
}

// C0 controls other than tab and line feed, DEL, C1 controls, and the
// bidirectional embedding, override and isolate characters that could make
// the comment read differently in an administrator's list.
const STRIPPED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/**
 * The comment as stored: line breaks become `\n`, other control and
 * bidirectional formatting characters are removed, lone surrogates become
 * U+FFFD and the ends are trimmed. Null when nothing is left (or none was
 * sent); undefined when the value is not a string or is still longer than
 * the limit, which the caller refuses instead of truncating.
 */
export function normalizeAnswerProblemReportComment(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > ANSWER_PROBLEM_REPORT_COMMENT_MAX * 4) return undefined;
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(STRIPPED, "")
    .replace(LONE_SURROGATE, "�")
    .trim();
  if (normalized.length > ANSWER_PROBLEM_REPORT_COMMENT_MAX) return undefined;
  return normalized === "" ? null : normalized;
}

/** The current user's own report on one answer. */
export type AnswerProblemReportWire = {
  reason: AnswerProblemReason;
  comment: string | null;
  /** When it was last sent. */
  updatedAt: string;
};

/** `GET /api/chats/[chatId]/messages/[messageId]/problem-report` */
export type AnswerProblemReportReadResponse = { report: AnswerProblemReportWire | null };

/** `PUT` body of the same route. */
export type AnswerProblemReportRequest = { reason: AnswerProblemReason; comment: string | null };

export type AnswerProblemReportSaveResponse = { outcome: "created" | "updated"; report: AnswerProblemReportWire };

/**
 * `answer_problem_report_unavailable` (404) covers an answer that does not
 * exist, that the user cannot see, or that is not a persisted, settled answer.
 */
export type AnswerProblemReportErrorCode =
  | "unauthorized"
  | "forbidden"
  | "answer_problem_report_invalid"
  | "answer_problem_report_unavailable"
  | "answer_problem_report_rate_limited"
  | "answer_problem_report_failed";

export type AnswerProblemReportErrorResponse = ErrorResponse<AnswerProblemReportErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAnswerProblemReportWire(value: unknown): AnswerProblemReportWire | null {
  if (!isRecord(value) || !isAnswerProblemReason(value.reason) || typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))) return null;
  const comment = value.comment;
  if (comment !== null && (typeof comment !== "string" || comment.length > ANSWER_PROBLEM_REPORT_COMMENT_MAX)) return null;
  return { comment, reason: value.reason, updatedAt: value.updatedAt };
}

export function decodeAnswerProblemReportReadResponse(value: unknown): AnswerProblemReportReadResponse | null {
  if (!isRecord(value) || !("report" in value)) return null;
  if (value.report === null) return { report: null };
  const report = decodeAnswerProblemReportWire(value.report);
  return report ? { report } : null;
}

export function decodeAnswerProblemReportSaveResponse(value: unknown): AnswerProblemReportSaveResponse | null {
  if (!isRecord(value) || (value.outcome !== "created" && value.outcome !== "updated")) return null;
  const report = decodeAnswerProblemReportWire(value.report);
  return report ? { outcome: value.outcome, report } : null;
}
