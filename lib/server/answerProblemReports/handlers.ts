import {
  isAnswerProblemReason,
  normalizeAnswerProblemReportComment,
  type AnswerProblemReportErrorCode,
  type AnswerProblemReportReadResponse,
  type AnswerProblemReportSaveResponse,
  type AnswerProblemReportWire
} from "../../contracts/answerProblemReports";
import type { LoginRateLimiter } from "../auth/rateLimit";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { AnswerProblemReportRecord, AnswerProblemReportRepository } from "./repository";

/** Creates and updates per user in one rolling window. */
export const ANSWER_PROBLEM_REPORT_RATE_LIMIT = 50;
export const ANSWER_PROBLEM_REPORT_RATE_LIMIT_WINDOW_MS = 24 * 3_600_000;

const ROUTE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BODY_KEYS = new Set(["comment", "reason"]);
const headers = { "cache-control": "private, no-store", vary: "Cookie" };

type Params = Promise<{ chatId: string; messageId: string }> | { chatId: string; messageId: string };

export type AnswerProblemReportHandlerDeps = Readonly<{
  now?: () => Date;
  rateLimiter: Pick<LoginRateLimiter, "check">;
  repository: () => AnswerProblemReportRepository;
  resolveAuth: RequestAuthResolver;
}>;

export function answerProblemReportRateLimitKey(userId: string): string {
  return `answer-problem-report:user:${userId}`;
}

function json(body: AnswerProblemReportReadResponse | AnswerProblemReportSaveResponse | { error: AnswerProblemReportErrorCode },
  status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { headers: { ...headers, ...extra }, status });
}

const unavailable = () => json({ error: "answer_problem_report_unavailable" }, 404);

function wire(record: AnswerProblemReportRecord): AnswerProblemReportWire {
  return { comment: record.comment, reason: record.reason, updatedAt: record.updatedAt.toISOString() };
}

/** A failed read or write: a content-free record, never the comment or the ids. */
function failed(error: unknown, stage: "read" | "write"): Response {
  logEvent("service_operation", { error, subsystem: "database", stage, outcome: "failed",
    code: "answer_problem_report_failed", prisma_code: databaseFailureCode(error) });
  return json({ error: "answer_problem_report_failed" }, 503);
}

/**
 * `GET` and `PUT /api/chats/[chatId]/messages/[messageId]/problem-report`:
 * the signed-in user's own report on a persisted, settled answer they can
 * see, and creating or updating it with `{ reason, comment }`. An answer
 * that does not exist, is not visible to the user or is not settled is one
 * privacy-neutral 404. Same-origin protection is the shared mutation guard.
 */
export function createAnswerProblemReportHandlers(deps: AnswerProblemReportHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  type Admission =
    | Readonly<{ ok: false; response: Response }>
    | Readonly<{ chatId: string; messageId: string; ok: true; userId: string }>;

  async function admit(request: Request, params: Params): Promise<Admission> {
    const session = await deps.resolveAuth(request);
    if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) };
    if (session.user.status !== "active") return { ok: false, response: json({ error: "forbidden" }, 403) };
    const { chatId, messageId } = await params;
    if (!ROUTE_ID.test(chatId) || !ROUTE_ID.test(messageId)) return { ok: false, response: unavailable() };
    return { chatId, messageId, ok: true, userId: session.userId };
  }

  return {
    async GET(request: Request, context: { params: Params }): Promise<Response> {
      const admitted = await admit(request, context.params);
      if (!admitted.ok) return admitted.response;
      try {
        const repository = deps.repository();
        const target = await repository.resolveAnswer({
          chatId: admitted.chatId, messageId: admitted.messageId, now: now(), userId: admitted.userId
        });
        if (!target) return unavailable();
        const report = await repository.readOwn(target, admitted.userId);
        return json({ report: report ? wire(report) : null });
      } catch (error) {
        return failed(error, "read");
      }
    },

    async PUT(request: Request, context: { params: Params }): Promise<Response> {
      const admitted = await admit(request, context.params);
      if (!admitted.ok) return admitted.response;
      const body = await readJsonBodyOrNull(request, "json");
      const tooLarge = requestBodyErrorResponse(body);
      if (tooLarge) return tooLarge;
      const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const comment = record ? normalizeAnswerProblemReportComment(record.comment) : undefined;
      if (!record || Object.keys(record).some((key) => !BODY_KEYS.has(key)) || !isAnswerProblemReason(record.reason) ||
        comment === undefined) {
        return json({ error: "answer_problem_report_invalid" }, 400);
      }
      const reason = record.reason;

      let limited: Awaited<ReturnType<LoginRateLimiter["check"]>>;
      try {
        limited = await deps.rateLimiter.check(answerProblemReportRateLimitKey(admitted.userId),
          { maxAttempts: ANSWER_PROBLEM_REPORT_RATE_LIMIT });
      } catch (error) {
        return failed(error, "write");
      }
      if (!limited.allowed) {
        return json({ error: "answer_problem_report_rate_limited" }, 429,
          { "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterSeconds))) });
      }

      try {
        const repository = deps.repository();
        const target = await repository.resolveAnswer({
          chatId: admitted.chatId, messageId: admitted.messageId, now: now(), userId: admitted.userId
        });
        if (!target) return unavailable();
        const saved = await repository.save({ comment, reason, target, userId: admitted.userId });
        if (!saved) return unavailable();
        logEvent("answer_problem_report", { outcome: saved.outcome, reason });
        return json({ outcome: saved.outcome, report: wire(saved.report) });
      } catch (error) {
        return failed(error, "write");
      }
    }
  };
}
