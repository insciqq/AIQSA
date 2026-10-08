import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { answerReviewSessionWire } from "./repository";
import { decodeAnswerReviewReviewerRequest, startAnswerReviewRound, type AnswerReviewServiceDeps } from "./service";
import { startAnswerReviewStep, type AnswerReviewStepStartDeps } from "./stepStart";

type Params<T> = Promise<T> | T;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
const json = (value: unknown, status = 200) => Response.json(value, { headers, status });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function failed(error: unknown): Response {
  logEvent("service_operation", { subsystem: "database", stage: "write", outcome: "failed",
    code: "answer_review_unavailable", prisma_code: databaseFailureCode(error) });
  return json({ error: "answer_review_unavailable" }, 503);
}

/**
 * Routes of manual answer review: starting a round on the chat's latest
 * answer, and starting a session's next step (whose response is that step's
 * ordinary run stream). Other users' and missing sessions look alike.
 */
export function createAnswerReviewHandlers(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: () => AnswerReviewServiceDeps;
  steps: () => AnswerReviewStepStartDeps;
}>) {
  return {
    /** `POST /api/chats/[chatId]/answer-reviews`: `{ answerMessageId, expectedActiveLeafId, reviewers }`. */
    async POST_ROUND(request: Request, context: { params: Params<{ chatId: string }> }): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
      const { chatId } = await context.params;
      if (!ID.test(chatId)) return json({ error: "answer_review_unavailable" }, 404);
      const body = await readJsonBodyOrNull(request, "json");
      const tooLarge = requestBodyErrorResponse(body);
      if (tooLarge) return tooLarge;
      const reviewers = record(body) ? decodeAnswerReviewReviewerRequest(body.reviewers) : null;
      if (!record(body) || !exactKeys(body, ["answerMessageId", "expectedActiveLeafId", "reviewers"]) || !reviewers ||
        typeof body.answerMessageId !== "string" || !ID.test(body.answerMessageId) ||
        typeof body.expectedActiveLeafId !== "string" || !ID.test(body.expectedActiveLeafId)) {
        return json({ error: "answer_review_invalid" }, 400);
      }
      try {
        const result = await startAnswerReviewRound(deps.service(), {
          answerMessageId: body.answerMessageId, chatId, expectedActiveLeafId: body.expectedActiveLeafId, reviewers,
          userId: session.userId
        });
        return result.ok
          ? json({ session: answerReviewSessionWire(result.session, session.userId) })
          : json({ error: result.code }, result.status);
      } catch (error) {
        return failed(error);
      }
    },

    /** `POST /api/answer-reviews/[sessionId]/steps`: `{ admissionId, controls, expectedActiveLeafId, kind }`. */
    async POST_STEP(request: Request, context: { params: Params<{ sessionId: string }> }): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
      const { sessionId } = await context.params;
      if (!ID.test(sessionId)) return json({ error: "answer_review_unavailable" }, 404);
      const body = await readJsonBodyOrNull(request, "json");
      const tooLarge = requestBodyErrorResponse(body);
      if (tooLarge) return tooLarge;
      if (!record(body) || !exactKeys(body, ["admissionId", "controls", "expectedActiveLeafId", "kind"]) ||
        (body.kind !== "review" && body.kind !== "revision") || !record(body.controls) ||
        typeof body.admissionId !== "string" || !ID.test(body.admissionId) ||
        typeof body.expectedActiveLeafId !== "string" || !ID.test(body.expectedActiveLeafId)) {
        return json({ error: "answer_review_invalid" }, 400);
      }
      try {
        const started = await startAnswerReviewStep(deps.steps(), {
          admissionId: body.admissionId,
          controls: body.controls,
          expectedActiveLeafId: body.expectedActiveLeafId,
          kind: body.kind,
          // The browser session is resolved again whenever the send asks.
          resolveAuth: () => deps.resolveAuth(request),
          sessionId,
          userId: session.userId
        });
        return started.response;
      } catch (error) {
        return failed(error);
      }
    }
  };
}
