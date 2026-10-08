import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";

/** Shared pieces of the two answer review routes, kept apart so neither route loads the other's services. */

export type RouteParams<T> = Promise<T> | T;
export const ANSWER_REVIEW_ROUTE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const headers = { "cache-control": "private, no-store", vary: "Cookie" };

export function answerReviewJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers, status });
}

export function isRouteRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactRouteKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function answerReviewUnavailable(error: unknown): Response {
  logEvent("service_operation", { subsystem: "database", stage: "write", outcome: "failed",
    code: "answer_review_unavailable", prisma_code: databaseFailureCode(error) });
  return answerReviewJson({ error: "answer_review_unavailable" }, 503);
}
