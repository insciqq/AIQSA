import {
  SCHEDULED_TASK_WEBHOOK_BODY_MAX_BYTES,
  SCHEDULED_TASK_WEBHOOK_ERROR_STATUS,
  SCHEDULED_TASK_WEBHOOK_REFUSAL,
  isScheduledTaskWebhookPublicId,
  type ScheduledTaskWebhookErrorCode
} from "../../contracts/scheduledTasks";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  scheduledWebhookEventBody,
  scheduledWebhookEventHeaders,
  scheduledWebhookRequestToken,
  scheduledWebhookTokenHash,
  scheduledWebhookTokenMatches
} from "./webhookEvent";

/** A webhook found by its public id, read before the request is authenticated. */
export type ScheduledTaskWebhookTarget = Readonly<{
  taskId: string;
  userId: string;
  /** Hex SHA-256 of the current token; null before the first one is issued. */
  tokenHash: string | null;
  /** The automation takes events now: its webhook trigger is on, it is active and its owner may run it. */
  open: boolean;
}>;

/** What an authenticated request becomes, decided under the automation's row lock. */
export type ScheduledTaskWebhookAcceptance =
  | Readonly<{ kind: "accepted" }>
  /** Its delivery key was accepted before and is still kept: no new event. */
  | Readonly<{ kind: "duplicate" }>
  /** The token, the trigger, the task or its owner changed since the request was authenticated. */
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "queue_full" }>
  /** Seconds until the oldest event of the rate window leaves it. */
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>;

export type ScheduledTaskWebhookEventInput = Readonly<{
  bodyText: string;
  contentType: string | null;
  dedupeKey: string | null;
  eventName: string | null;
}>;

export type ScheduledTaskWebhookIntakeStore = Readonly<{
  find(publicId: string): Promise<ScheduledTaskWebhookTarget | null>;
  /**
   * Under the task's row lock: rechecks the token hash and that the
   * automation takes events, then deduplicates, applies the queue and rate
   * caps and queues the event with its `receivedAt`.
   */
  accept(input: Readonly<{
    event: ScheduledTaskWebhookEventInput;
    publicId: string;
    taskId: string;
    tokenHash: string;
    userId: string;
  }>): Promise<ScheduledTaskWebhookAcceptance>;
}>;

const HEADERS = { "cache-control": "no-store" } as const;

/**
 * The one refusal, the same body and headers for an unknown webhook, a
 * missing, malformed or wrong token (one sent only in the URL included), a
 * trigger that is off, a task that is not active and an owner who is not.
 */
function refusal(): Response {
  return Response.json({ error: SCHEDULED_TASK_WEBHOOK_REFUSAL.error },
    { headers: HEADERS, status: SCHEDULED_TASK_WEBHOOK_REFUSAL.status });
}

function failure(code: ScheduledTaskWebhookErrorCode, headers: Readonly<Record<string, string>> = {}): Response {
  return Response.json({ error: code }, { headers: { ...HEADERS, ...headers }, status: SCHEDULED_TASK_WEBHOOK_ERROR_STATUS[code] });
}

function accepted(): Response {
  return Response.json({ accepted: true }, { headers: HEADERS, status: 202 });
}

/** Content-free: never the token, the body, a header or the public id. */
function unavailable(error: unknown, stage: "read" | "write"): Response {
  logEvent("service_operation", {
    code: "scheduled_tasks_unavailable", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage,
    subsystem: "scheduled_tasks"
  });
  return Response.json({ error: "scheduled_tasks_unavailable" }, { headers: HEADERS, status: 503 });
}

/**
 * `POST /api/automations/hooks/[publicId]`: a sender's event for one
 * automation. The request is authenticated before anything else is read,
 * and every way it can fail authentication gets the same refusal; then the
 * body is read within its bound and decoded, and the event is queued for the
 * runner, which is woken. The sender gets 202 without waiting for any model
 * work, a repeated delivery key included.
 */
export function createScheduledTaskWebhookIntake(deps: Readonly<{
  /** Wakes the runner after an event is queued. */
  kick?: () => void;
  store: ScheduledTaskWebhookIntakeStore;
}>) {
  return async function receive(request: Request, publicId: string): Promise<Response> {
    const token = scheduledWebhookRequestToken(request.headers);
    if (!isScheduledTaskWebhookPublicId(publicId) || token === null) return refusal();
    const tokenHash = scheduledWebhookTokenHash(token);
    let target: ScheduledTaskWebhookTarget | null;
    try {
      target = await deps.store.find(publicId);
    } catch (error) {
      return unavailable(error, "read");
    }
    // Always one constant-time comparison, against a stand-in without a webhook or token.
    const matches = scheduledWebhookTokenMatches(target?.tokenHash ?? null, tokenHash);
    if (!target || !matches || !target.open) return refusal();

    // Authenticated: only now are the event's headers and body read.
    const facts = scheduledWebhookEventHeaders(request.headers);
    if (!facts) return failure("webhook_headers_invalid");
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedRequestBody(request, { maxBytes: SCHEDULED_TASK_WEBHOOK_BODY_MAX_BYTES });
    } catch (error) {
      return failure(error instanceof RequestBodyTooLargeError ? "webhook_body_too_large" : "webhook_body_invalid");
    }
    const bodyText = scheduledWebhookEventBody(bytes, facts.contentType);
    if (bodyText === null) return failure("webhook_body_invalid");
    let outcome: ScheduledTaskWebhookAcceptance;
    try {
      outcome = await deps.store.accept({
        event: { ...facts, bodyText }, publicId, taskId: target.taskId, tokenHash, userId: target.userId
      });
    } catch (error) {
      return unavailable(error, "write");
    }
    switch (outcome.kind) {
      case "accepted":
        deps.kick?.();
        return accepted();
      case "duplicate":
        return accepted();
      case "refused":
        return refusal();
      case "queue_full":
        return failure("webhook_queue_full");
      case "rate_limited":
        return failure("webhook_rate_limited", { "retry-after": String(outcome.retryAfterSeconds) });
    }
  };
}
