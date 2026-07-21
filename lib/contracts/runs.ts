import type { ErrorResponse, SessionErrorCode } from "./http";

export type RunEventView = {
  data: unknown;
  type: string;
};

export type ModelRunEventProjection = {
  eventType: string;
  payload: unknown;
  sequence: number;
};

export type ModelRunStatus =
  | "cancelled"
  | "complete"
  | "error"
  | "in_progress"
  | "queued"
  | "streaming";

/**
 * The client-visible model-run fields. Persistence adapters may return
 * additional inspection fields without making them part of the wire contract.
 */
export type ModelRunResponseProjection = {
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  errorPayload: unknown;
  estimatedCostMicros: number | null;
  events: ModelRunEventProjection[];
  id: string;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  provider: string;
  reasoningTokens: number;
  searchRuns: unknown[];
  status: ModelRunStatus;
  totalTokens: number;
};

export type PersistedRun = ModelRunResponseProjection;

export type GetModelRunResponse = {
  run: ModelRunResponseProjection;
};

export type CancelModelRunProjection = {
  id: string;
  providerCancelPreview?: Record<string, unknown>;
  providerResponseId?: string | null;
  status: ModelRunStatus;
};

export type CancelModelRunSuccessResponse = {
  run: CancelModelRunProjection & {
    status: "cancelled";
  };
};

export type CancelModelRunNotCancelableResponse = {
  error: "model_run_not_cancelable";
  run: CancelModelRunProjection;
};

export type CancelModelRunResponse =
  | CancelModelRunSuccessResponse
  | CancelModelRunNotCancelableResponse;

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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function decodeGetModelRunResponse(value: unknown): PersistedRun | null {
  if (!isRecord(value) || !isRecord(value.run)) {
    return null;
  }

  const run = value.run;
  if (!Array.isArray(run.events)) {
    return null;
  }

  const id = nonEmptyString(run.id);
  const inputTokens = finiteNumber(run.inputTokens);
  const modelId = nonEmptyString(run.modelId);
  const provider = nonEmptyString(run.provider);
  const status = modelRunStatus(run.status);
  if (!id || inputTokens === null || !modelId || !provider || !status) {
    return null;
  }

  const events: ModelRunEventProjection[] = [];
  for (const event of run.events) {
    if (!isRecord(event)) {
      return null;
    }

    const eventType = nonEmptyString(event.eventType);
    const sequence = finiteNumber(event.sequence);
    if (!eventType || sequence === null) {
      return null;
    }

    events.push({
      eventType,
      payload: event.payload,
      sequence
    });
  }

  const cachedInputTokens = finiteNumber(run.cachedInputTokens) ?? 0;
  const cacheWriteInputTokens = finiteNumber(run.cacheWriteInputTokens) ?? 0;
  const estimatedCostMicros = finiteNumber(run.estimatedCostMicros);
  const outputTokens = finiteNumber(run.outputTokens) ?? 0;
  const reasoningTokens = finiteNumber(run.reasoningTokens) ?? 0;
  const totalTokens = finiteNumber(run.totalTokens) ?? inputTokens + outputTokens;

  return {
    cachedInputTokens,
    cacheWriteInputTokens,
    errorPayload: run.errorPayload,
    estimatedCostMicros:
      estimatedCostMicros !== null && estimatedCostMicros > 0 ? estimatedCostMicros : null,
    events,
    id,
    inputTokens,
    modelId,
    outputTokens,
    provider,
    reasoningTokens,
    searchRuns: Array.isArray(run.searchRuns) ? run.searchRuns : [],
    status,
    totalTokens
  };
}
