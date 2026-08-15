import type { ErrorResponse, SessionErrorCode } from "./http";

export type RunEventView = {
  data: unknown;
  type: string;
};

export type ModelRunStatus =
  | "cancelled"
  | "complete"
  | "error"
  | "in_progress"
  | "queued"
  | "streaming";

export const RUN_OUTCOME_RESPONSE_VERSION = 1 as const;

/**
 * The complete browser-visible projection for an owner-authorized run read.
 * Answer content and outputs are reconciled through the chat projection.
 */
export type RunOutcome = Readonly<{
  id: string;
  status: ModelRunStatus;
}>;

export type RunOutcomeResponse = Readonly<{
  run: RunOutcome;
  version: typeof RUN_OUTCOME_RESPONSE_VERSION;
}>;

export type CancelModelRunProjection = Readonly<{
  id: string;
  status: ModelRunStatus;
}>;

export type CancelModelRunSuccessResponse = Readonly<{
  run: CancelModelRunProjection & {
    status: "cancelled";
  };
}>;

export type CancelModelRunNotCancelableResponse = Readonly<{
  error: "model_run_not_cancelable";
  run: CancelModelRunProjection;
}>;

export type DecodedCancelModelRunResponse =
  | {
      kind: "cancelled";
      run: CancelModelRunProjection & {
        status: "cancelled";
      };
    }
  | {
      kind: "not_cancelled";
      run: CancelModelRunProjection;
    };

export type ModelRunServerErrorCode =
  | SessionErrorCode
  | "model_run_not_cancelable"
  | "model_run_not_found";

export type ModelRunErrorResponse = ErrorResponse<ModelRunServerErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function modelRunStatus(value: unknown): ModelRunStatus | null {
  return value === "cancelled" ||
    value === "complete" ||
    value === "error" ||
    value === "in_progress" ||
    value === "queued" ||
    value === "streaming"
    ? value
    : null;
}

export function decodeCancelModelRunResponse(
  value: unknown
): DecodedCancelModelRunResponse | null {
  if (!isRecord(value) || !isRecord(value.run)) {
    return null;
  }

  const id = nonEmptyString(value.run.id);
  const status = modelRunStatus(value.run.status);
  if (!id || !status) {
    return null;
  }

  if (!("error" in value)) {
    return status === "cancelled"
      ? {
          kind: "cancelled",
          run: {
            id,
            status
          }
        }
      : null;
  }

  if (value.error !== "model_run_not_cancelable") {
    return null;
  }

  return {
    kind: "not_cancelled",
    run: {
      id,
      status
    }
  };
}

export function decodeRunOutcomeResponse(value: unknown): RunOutcome | null {
  if (
    !isRecord(value) ||
    value.version !== RUN_OUTCOME_RESPONSE_VERSION ||
    !isRecord(value.run)
  ) {
    return null;
  }

  const id = nonEmptyString(value.run.id);
  const status = modelRunStatus(value.run.status);
  return id && status ? { id, status } : null;
}
