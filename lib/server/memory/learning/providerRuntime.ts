import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ModelRunSseEvent,
  ModelRunUsage
} from "../../../domain/modelRunEvents";
import { maxOutputTokensFromParams } from "../../../domain/providerParams";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  ProviderConfigurationError,
  type ProviderConnectionConfiguration
} from "../../providers/providerConfiguration";
import {
  createProviderSafeFetch,
  ProviderSafeFetchError
} from "../../providers/providerSafeFetch";
import { ProviderResponseTooLargeError } from "../../providers/network";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import { ProviderStreamSafetyError } from "../../providers/streamSafety";
import type { ProviderRunRequest, ProviderRunResult } from "../../providers/types";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { ModelToolCall } from "../../tools/types";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

export type MemoryLearningProviderEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type MemoryLearningProviderResult = Readonly<{
  providerResponseId: string | null;
  toolCalls: readonly ModelToolCall[] | undefined;
  usage: ModelRunUsage;
}>;

export type MemoryLearningProviderFailureClassification =
  | "UNKNOWN"
  | "REPLAY_SAFE_TRANSIENT"
  | "PERMANENT";

export type MemoryLearningProviderFailure = Readonly<{
  cause: unknown;
  classification: MemoryLearningProviderFailureClassification;
  usage: ModelRunUsage | null;
}>;

type RuntimeClient = Pick<PrismaClient, "$transaction">;

export const MEMORY_REASONING_TOOL_OUTPUT_TOKEN_FLOOR = 8_192;

const replaySafeTransientHttpStatuses = new Set([
  408,
  429,
  500,
  502,
  503,
  504
]);

class MemoryLearningHttpStatusError extends Error {
  readonly classification: Exclude<
    MemoryLearningProviderFailureClassification,
    "UNKNOWN"
  >;

  constructor(readonly status: number) {
    super("memory_learning_provider_http_failure");
    this.name = "MemoryLearningHttpStatusError";
    this.classification = replaySafeTransientHttpStatuses.has(status)
      ? "REPLAY_SAFE_TRANSIENT"
      : "PERMANENT";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasoningEnabled(
  snapshot: ProviderExecutionSnapshot,
  request: ProviderRunRequest
): boolean {
  if (!snapshot.model.capabilities.reasoning) return false;
  const value = isRecord(request.params.reasoning)
    ? request.params.reasoning
    : isRecord(snapshot.model.defaultParams.reasoning)
      ? snapshot.model.defaultParams.reasoning
      : {};
  if (value.enabled === false || value.effort === "none") return false;
  if (value.enabled === true || typeof value.effort === "string") return true;
  return typeof snapshot.model.capabilities.defaultReasoningEffort === "string" &&
    snapshot.model.capabilities.defaultReasoningEffort !== "none";
}

/** Reasoning tokens share the completion ceiling on forced structured tool
 * routes. Keep the semantic role's ordinary cap for non-reasoning models, but
 * give an enabled reasoning model enough total headroom to emit the same
 * bounded schema after thinking. The model's configured/default ceiling still
 * limits the uplift, and no provider or model name participates. */
export function applyMemoryLearningReasoningBudget(
  snapshot: ProviderExecutionSnapshot,
  request: ProviderRunRequest,
  options: Readonly<{ reasoningToolOutputTokenFloor?: number }> = {}
): ProviderRunRequest {
  const strictSingleTool = request.toolChoice === "required" &&
    request.tools?.length === 1 && request.tools[0]?.strict === true;
  const requested = maxOutputTokensFromParams(request.params);
  if (!strictSingleTool || requested === undefined ||
    !reasoningEnabled(snapshot, request)) return request;

  const requestedFloor = options.reasoningToolOutputTokenFloor ??
    MEMORY_REASONING_TOOL_OUTPUT_TOKEN_FLOOR;
  if (!Number.isSafeInteger(requestedFloor) || requestedFloor < 1 ||
    requestedFloor > MEMORY_REASONING_TOOL_OUTPUT_TOKEN_FLOOR) {
    throw new Error("memory_reasoning_tool_budget_invalid");
  }
  const configuredLimit = maxOutputTokensFromParams(snapshot.model.defaultParams);
  const capabilityLimit = snapshot.model.capabilities.defaultMaxOutputTokens;
  const limits = [configuredLimit, capabilityLimit].filter(
    (value): value is number => typeof value === "number" &&
      Number.isFinite(value) && value > 0
  );
  const ceiling = limits.length > 0 ? Math.min(...limits) : null;
  const reasoningFloor = ceiling === null
    ? requestedFloor
    : Math.min(requestedFloor, ceiling);
  const adjusted = Math.max(requested, reasoningFloor);
  if (adjusted === requested) return request;
  return {
    ...request,
    params: {
      ...request.params,
      maxOutputTokens: adjusted,
      max_output_tokens: adjusted
    }
  };
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function boundedProviderResponseId(value: string | undefined): string | null {
  return value && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
}

function memoryProviderAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Credential reauthorization is read-only but may wait for a database
 * connection or row lock. It must not extend an already-expired interactive
 * provider budget. The underlying transaction is still observed to terminal
 * settlement, while the caller is released immediately and therefore cannot
 * dispatch provider I/O after cancellation.
 */
function awaitMemoryProviderAuthority<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(memoryProviderAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T | unknown) => void, value: T | unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, memoryProviderAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(resolve as (value: T | unknown) => void, value),
      (error) => finish(reject, error)
    );
    if (signal.aborted) onAbort();
  });
}

function classifyProviderFailure(
  cause: unknown,
  observedEvent: boolean
): MemoryLearningProviderFailureClassification {
  // Once the adapter has yielded anything, dispatch happened and a retry can
  // no longer prove that it will not duplicate provider work.
  if (observedEvent) return "UNKNOWN";

  // The accepted-learning fetch fence observes the status before any adapter
  // parses it. This gives every provider the same typed, body-free decision.
  if (cause instanceof MemoryLearningHttpStatusError) {
    return cause.classification;
  }

  if (cause instanceof ProviderSafeFetchError) {
    // DNS resolution happens before the pinned request is dispatched.
    if (cause.code === "provider_http_dns_failed") {
      return "REPLAY_SAFE_TRANSIENT";
    }
    // A generic request failure may occur after bytes reached the provider.
    if (cause.code === "provider_http_request_failed") return "UNKNOWN";
    return "PERMANENT";
  }

  if (
    cause instanceof ProviderConfigurationError ||
    cause instanceof ProviderResponseTooLargeError ||
    cause instanceof ProviderStreamSafetyError
  ) {
    return "PERMANENT";
  }

  // Timeouts, aborts, untyped adapter errors, and network failures are
  // deliberately ambiguous. Never infer replay safety from an error string.
  return "UNKNOWN";
}

async function collectProviderResult(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>,
  callError: (
    usage: ModelRunUsage | null,
    cause: unknown,
    classification: MemoryLearningProviderFailureClassification
  ) => Error
): Promise<ProviderRunResult> {
  let lastUsage: ModelRunUsage | null = null;
  let observedEvent = false;
  try {
    let next = await stream.next();
    while (!next.done) {
      observedEvent = true;
      if (next.value.type === "usage") lastUsage = next.value.data;
      next = await stream.next();
    }
    return next.value;
  } catch (error) {
    throw callError(
      lastUsage,
      error,
      classifyProviderFailure(error, observedEvent)
    );
  }
}

/**
 * Owns the credential fence and provider invocation shared only by Memory
 * extraction, consolidation, and verification. Prompts and persistence stay
 * with their domain-specific callers.
 */
export function createAcceptedMemoryLearningProvider<
  Evidence extends MemoryLearningProviderEvidence,
  Request
>(
  client: RuntimeClient,
  input: Readonly<{
    buildRequest(snapshot: ProviderExecutionSnapshot, request: Request): ProviderRunRequest;
    callError(
      usage: ModelRunUsage | null,
      cause: unknown,
      classification: MemoryLearningProviderFailureClassification
    ): Error;
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
    invalidRuntimeError: string;
    reasoningToolOutputTokenFloor?: number;
    validate?(
      evidence: Evidence,
      snapshot: ProviderExecutionSnapshot,
      request: Request
    ): boolean;
  }>
): (
  evidence: Evidence,
  request: Request,
  signal: AbortSignal
) => Promise<MemoryLearningProviderResult> {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;

  return async (evidence, request, signal) => {
    if (signal.aborted) throw memoryProviderAbortReason(signal);
    const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
    if (
      snapshot.connectionId !== evidence.connectionId ||
      snapshot.providerModelId !== evidence.providerModelId ||
      snapshot.credentialId !== evidence.credentialId ||
      snapshot.credentialVersionId !== evidence.credentialVersionId ||
      snapshot.model.adapterKind === "fake" ||
      snapshot.model.modelClass !== "answer" ||
      snapshot.model.capabilities.toolCalling !== true ||
      input.validate?.(evidence, snapshot, request) === false
    ) {
      throw new Error(input.invalidRuntimeError);
    }

    const authenticationMode = providerAuthenticationMode(snapshot.connection);
    const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
      awaitMemoryProviderAuthority(client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${evidence.credentialId}
            AND "id" = ${evidence.credentialVersionId}
          FOR SHARE
        `);
        const version = rows[0];
        if (
          !version || version.revokedAt ||
          version.credentialId !== evidence.credentialId ||
          version.id !== evidence.credentialVersionId ||
          expectNoAuth !== noAuthEvidence(version.testEvidence) ||
          expectNoAuth !== (version.secretEnvelope === null)
        ) {
          throw new Error("credential_revoked");
        }
        return version.secretEnvelope === null
          ? null
          : decryptProviderCredentialSecret({
              credentialId: version.credentialId,
              envelope: version.secretEnvelope,
              key: encryptionKey(),
              valueId: version.id
            });
      }), signal);
    const baseFetch = input.createFetch?.(snapshot.connection) ??
      createProviderSafeFetch({ configuration: snapshot.connection });
    let observedSuccessfulHttpResponse = false;
    const statusCheckedFetch: typeof fetch = async (fetchRequest, init) => {
      const response = await baseFetch(fetchRequest, init);
      if (response.ok) {
        observedSuccessfulHttpResponse = true;
        return response;
      }
      // A provider lifecycle may intentionally retry a follow-up poll. Once
      // the initial request succeeded, leave later statuses to that lifecycle;
      // collectProviderResult will still treat any escaped error as UNKNOWN
      // because the adapter has already emitted dispatch evidence.
      if (observedSuccessfulHttpResponse) return response;
      try {
        await response.body?.cancel();
      } catch {
        // The body is never inspected; cancellation is best-effort cleanup.
      }
      throw new MemoryLearningHttpStatusError(response.status);
    };
    const fetchFn: typeof fetch = authenticationMode === "none"
      ? async (fetchRequest, init) => {
          await lockCredential(true);
          return statusCheckedFetch(fetchRequest, init);
        }
      : statusCheckedFetch;
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: authenticationMode === "none"
        ? null
        : async () => {
            const secret = await lockCredential(false);
            if (secret === null) throw new Error("credential_revoked");
            return secret;
          },
      snapshot
    });
    if (!runtime.toolBridge?.supportsToolCalling({
      modelId: snapshot.model.upstreamModelId,
      provider: snapshot.providerFamily
    })) {
      throw new Error(input.invalidRuntimeError);
    }
    const providerRequest = applyMemoryLearningReasoningBudget(
      snapshot,
      input.buildRequest(snapshot, request),
      {
        ...(input.reasoningToolOutputTokenFloor === undefined
          ? {}
          : { reasoningToolOutputTokenFloor: input.reasoningToolOutputTokenFloor })
      }
    );
    const result = await collectProviderResult(
      runtime.adapter.stream(providerRequest, { signal }),
      input.callError
    );
    return {
      providerResponseId: boundedProviderResponseId(result.providerResponseId),
      toolCalls: result.toolCalls,
      usage: result.usage
    };
  };
}
