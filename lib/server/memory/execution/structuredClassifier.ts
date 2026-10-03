import { memoryReportedUsage } from "./usage";
import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../../domain/usage";
import { createAcceptedStructuredOutputSnapshotExecutor } from
  "../../providerRuntime/structuredOutputExecutor";
import type { ProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import type {
  ProviderStructuredOutputRequest
} from "../../providers/structuredOutput";
import { StructuredOutputDecodeError, supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { resolveProviderToolChoice } from "../../providers/providerToolChoice";
import { memoryRoleRequiresForcedToolCall } from "./roles";
import {
  memoryExecutionNow,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies
} from "./authority";
import { createPrismaMemoryExecutionAdmission } from "./admission";
import { memoryExecutionSha256 } from "./canonical";
import type { MemoryExecutionVersions } from "./compatibility";
import { MemoryExecutionError, memoryExecutionFailure } from "./errors";
import {
  createPrismaMemoryExecutionLifecycle,
  type MemoryExecutionDurableResultEvidence,
  type MemoryReportedUsage
} from "./lifecycle";
import { memoryOutputDecodeReason, type MemoryOutputDecodeReason } from "./outputViolation";
import { memoryExecutionOwnerWhere, type MemoryExecutionOwner } from "./owner";
import type { MemoryExecutionRole } from "./roles";
import { logEvent } from "../../observability";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import {
  withLockedMemoryTransaction,
  type MemoryTransaction
} from "../persistence/transaction";
import { MEMORY_ADMISSION_MAX_TIMEOUT_MS } from "../admissionDeadline";
import { memoryStructuredOutputRequest } from "./outputBudget";

export const MEMORY_STRUCTURED_OUTPUT_PROVIDER_TIMEOUT_MS =
  MEMORY_ADMISSION_MAX_TIMEOUT_MS;

export type MemoryStructuredOutputProviderResult = Readonly<{
  output: Record<string, unknown>;
  providerResponseId: string | null;
  usage: ModelRunUsage | null;
}>;

export type MemoryStructuredOutputProvider = Readonly<{
  run(
    snapshot: MemorySecretFreeExecutionSnapshot,
    request: ProviderStructuredOutputRequest,
    signal: AbortSignal
  ): Promise<MemoryStructuredOutputProviderResult>;
}>;

export type GovernedMemoryStructuredOutput<Value> = Readonly<{
  acceptedOutputHash: string;
  bindingId: string;
  classifiedAt: Date;
  inputHash: string;
  modelId: string;
  policyVersion: string;
  providerId: string;
  value: Value;
}>;

export class MemoryStructuredOutputProviderError extends Error {
  readonly outputLimitExceeded: boolean;
  readonly outputInvalid: boolean;
  /** Transport decode reason of a received answer; null for other failures. */
  readonly decodeReason: MemoryOutputDecodeReason | null;
  constructor(
    readonly providerResponseId: string | null,
    readonly usage: ModelRunUsage | null,
    options: Readonly<{ cause?: unknown }> = {}
  ) {
    super("memory_structured_output_provider_failed", options);
    this.name = "MemoryStructuredOutputProviderError";
    this.outputLimitExceeded = options.cause instanceof Error &&
      "code" in options.cause && options.cause.code === "structured_output_output_limit_exceeded";
    this.outputInvalid = options.cause instanceof StructuredOutputDecodeError;
    this.decodeReason = this.outputInvalid ? memoryOutputDecodeReason(options.cause) : null;
  }
}

/** Binding errorCode of a call fenced before dispatch. */
export const MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE = "memory_classifier_dispatch_fenced";

/** Thrown by a provider wrapper before it calls the real provider, for example
 * when the source it is about to disclose changed. Nothing was sent: the
 * binding settles CANCELLED without usage and the call is never retried. The
 * optional content-free code is for the caller's own mapping only. */
export class MemoryStructuredOutputDispatchFenced extends Error {
  readonly code: string;
  constructor(code: string = MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE) {
    const stable = /^[a-z][a-z0-9_]{0,63}$/u.test(code)
      ? code
      : MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE;
    super(stable);
    this.name = "MemoryStructuredOutputDispatchFenced";
    this.code = stable;
  }
}

/** A settled invalid answer buys at most this many calls in total per input. */
export const MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS = 3;
/** Retries stop once the owner holds this many settled invalid answers for the
 * role, so one job and role pays for at most three validation retries however
 * many inputs it has. A first attempt is never blocked. */
export const MEMORY_STRUCTURED_OUTPUT_INVALID_OUTPUT_BREAKER = 4;

/** Opt-in retry of a settled invalid answer. `attempt` counts retries from 1;
 * the first call uses the input ordinal. Each retry needs a fresh ordinal.
 * A retry discloses its input again, so `beforeRetry` revalidates whatever the
 * caller proved before the first call (source versions, fences); it runs after
 * the previous call settled and before binding, and its error stops the call.
 * Owner liveness and Memory authority are rechecked by every bind and start. */
export type MemoryStructuredOutputValidationRetry = Readonly<{
  maxAttempts: number;
  allocateOrdinal(attempt: number): number | Promise<number>;
  beforeRetry?(attempt: number): void | Promise<void>;
}>;

export const unavailableMemoryReportedUsage: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});


function reasoningEffort(
  snapshot: MemorySecretFreeExecutionSnapshot
): string | null {
  const value = snapshot.providerExecutionSnapshot.model.defaultParams.reasoning;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const effort = (value as Record<string, unknown>).effort;
  return typeof effort === "string" && effort.trim() === effort &&
    effort.length > 0 && effort.length <= 32
    ? effort
    : null;
}

/** Execute a strict-schema request only against the provider tuple already
 * accepted by Memory execution admission. Mutable System Model resolution is
 * deliberately absent from this network boundary. */
export function createAcceptedMemoryStructuredOutputProvider(
  client: Pick<PrismaClient, "$transaction">,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): MemoryStructuredOutputProvider {
  const execute = createAcceptedStructuredOutputSnapshotExecutor(client, options);
  return Object.freeze({
    async run(snapshot, request, signal) {
      let providerResponseId: string | null = null;
      let usage: ModelRunUsage | null = null;
      try {
        const admittedRequest = memoryStructuredOutputRequest(snapshot, request);
        const output = await execute(
          snapshot.providerExecutionSnapshot,
          {
            ...admittedRequest,
            reasoningEffort: admittedRequest.reasoningEffort ?? reasoningEffort(snapshot)
          },
          {
            onProviderResponseId: (value) => { providerResponseId = value; },
            onUsage: (value) => { usage = mergeTokenUsage(usage ?? {}, value); },
            signal,
            // Interactive Memory is bounded by its administrator-selected
            // outer AbortSignal. Keep this transport ceiling at the product
            // maximum so a hidden shorter per-call cap cannot pre-empt it.
            timeoutMs: MEMORY_STRUCTURED_OUTPUT_PROVIDER_TIMEOUT_MS
          }
        );
        return { output, providerResponseId, usage };
      } catch (error) {
        throw new MemoryStructuredOutputProviderError(
          providerResponseId,
          usage === null ? null : normalizeTokenUsage({
            ...normalizeTokenUsage(usage), completeness: "partial"
          }),
          { cause: error }
        );
      }
    }
  });
}

export type GovernedMemoryStructuredOutputInput<Value> = Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  client: PrismaClient;
  decode(value: unknown): Value;
  inputHash: string;
  ordinal: number;
  owner: MemoryExecutionOwner;
  persistResult?: (
    tx: MemoryTransaction,
    result: MemoryExecutionDurableResultEvidence & Readonly<{
      acceptedOutputHash: string;
      inputHash: string;
      /** Ordinal of the accepted call, which differs from `ordinal` after a retry. */
      ordinal: number;
      value: Value;
    }>
  ) => Promise<void>;
  provider: MemoryStructuredOutputProvider;
  request: ProviderStructuredOutputRequest;
  role: MemoryExecutionRole;
  signal: AbortSignal;
  userId: string;
  validationRetry?: MemoryStructuredOutputValidationRetry;
  versions: MemoryExecutionVersions;
}>;

type GovernedExecution = Readonly<{
  admission: ReturnType<typeof createPrismaMemoryExecutionAdmission>;
  lifecycle: ReturnType<typeof createPrismaMemoryExecutionLifecycle>;
}>;

/** Only an answer that was received, rejected and durably settled FAILED as
 * invalid output may buy another call; every other outcome throws. */
type GovernedAttempt<Value> =
  | Readonly<{ kind: "succeeded"; result: GovernedMemoryStructuredOutput<Value> }>
  | Readonly<{ error: unknown; kind: "output_invalid" }>;

const OUTPUT_INVALID_CODE = "memory_classifier_output_invalid";

async function executeGovernedAttempt<Value>(
  input: GovernedMemoryStructuredOutputInput<Value>,
  execution: GovernedExecution,
  ordinal: number
): Promise<GovernedAttempt<Value>> {
  const binding = await execution.admission.bind(input.userId, {
    inputHash: input.inputHash,
    ordinal,
    owner: input.owner,
    role: input.role,
    versions: input.versions
  });
  const started = await execution.admission.start(input.userId, binding.id);
  if (
    started.snapshot.logicalRole !== input.role ||
    !started.snapshot.requiresStrictStructuredOutput
  ) {
    await execution.lifecycle.settle(input.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_classifier_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableMemoryReportedUsage
    });
    throw new Error("memory_classifier_binding_invalid");
  }

  let providerResult: MemoryStructuredOutputProviderResult;
  try {
    providerResult = await input.provider.run(
      started.snapshot,
      input.request,
      input.signal
    );
  } catch (error) {
    if (error instanceof MemoryStructuredOutputDispatchFenced) {
      await execution.lifecycle.settle(input.userId, binding.id, {
        acceptedOutputHash: null,
        errorCode: MEMORY_STRUCTURED_OUTPUT_DISPATCH_FENCED_CODE,
        providerResponseId: null,
        state: "CANCELLED",
        usage: unavailableMemoryReportedUsage
      });
      throw error;
    }
    const failure = error instanceof MemoryStructuredOutputProviderError
      ? error
      : null;
    const invalid = !input.signal.aborted && failure?.outputInvalid === true;
    await execution.lifecycle.settle(input.userId, binding.id, {
      acceptedOutputHash: null,
      decodeReason: invalid ? (failure?.decodeReason ?? null) : null,
      errorCode: input.signal.aborted
        ? "memory_classifier_cancelled"
        : failure?.outputLimitExceeded ? "memory_classifier_output_limit_exceeded"
          : invalid ? OUTPUT_INVALID_CODE
          : "memory_classifier_provider_unavailable",
      providerResponseId: failure?.providerResponseId ?? null,
      state: input.signal.aborted ? "CANCELLED" : "FAILED",
      usage: memoryReportedUsage(failure?.usage ?? null)
    });
    if (invalid) return { error, kind: "output_invalid" };
    throw error;
  }

  let value: Value;
  try {
    value = input.decode(providerResult.output);
  } catch (error) {
    await execution.lifecycle.settle(input.userId, binding.id, {
      acceptedOutputHash: null,
      decodeReason: memoryOutputDecodeReason(error),
      errorCode: OUTPUT_INVALID_CODE,
      providerResponseId: providerResult.providerResponseId,
      state: "FAILED",
      usage: memoryReportedUsage(providerResult.usage)
    });
    return { error, kind: "output_invalid" };
  }
  const acceptedOutputHash = memoryExecutionSha256({
    inputHash: input.inputHash,
    output: value,
    role: input.role,
    version: 1
  });
  const settlement = {
    acceptedOutputHash,
    errorCode: null,
    providerResponseId: providerResult.providerResponseId,
    state: "SUCCEEDED" as const,
    usage: memoryReportedUsage(providerResult.usage)
  };
  const persistResult = input.persistResult;
  const settled = persistResult
    ? await execution.lifecycle.settleSucceededWithDurableResult(
        input.userId,
        binding.id,
        settlement,
        (tx, evidence) => persistResult(tx, {
          ...evidence,
          acceptedOutputHash,
          inputHash: input.inputHash,
          ordinal,
          value
        })
      )
    : await execution.lifecycle.settle(input.userId, binding.id, settlement);
  const provider = started.snapshot.providerExecutionSnapshot;
  return {
    kind: "succeeded",
    result: {
      acceptedOutputHash,
      bindingId: binding.id,
      classifiedAt: settled.completedAt,
      inputHash: input.inputHash,
      modelId: provider.providerModelId,
      policyVersion: input.versions.policyVersion,
      providerId: provider.providerFamily,
      value
    }
  };
}

function settledInvalidOutputs<Value>(
  input: GovernedMemoryStructuredOutputInput<Value>
): Promise<number> {
  return input.client.memoryExecutionBinding.count({
    where: {
      ...memoryExecutionOwnerWhere(input.userId, input.owner),
      errorCode: OUTPUT_INVALID_CODE,
      logicalRole: input.role,
      state: "FAILED"
    }
  });
}

/** Execute one accepted structured call. With `validationRetry`, an answer
 * that was received but rejected, and durably settled FAILED as invalid
 * output, buys a new call with the identical request and input hash: each call
 * is revalidated by `beforeRetry`, binds a fresh ordinal, reauthorizes at
 * start and records its own usage. Cancellation, unavailable providers, output
 * limits, invalid bindings, fenced dispatch and failed settlement are never
 * retried. When retries stop, the last call's own error is rethrown unchanged
 * for the caller's mapping; an error from the retry hooks is rethrown as is. */
export async function executeGovernedMemoryStructuredOutput<Value>(
  input: GovernedMemoryStructuredOutputInput<Value>
): Promise<GovernedMemoryStructuredOutput<Value>> {
  const retry = input.validationRetry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
    maxAttempts > MEMORY_STRUCTURED_OUTPUT_VALIDATION_MAX_ATTEMPTS ||
    (retry !== undefined && (typeof retry.allocateOrdinal !== "function" ||
      (retry.beforeRetry !== undefined && typeof retry.beforeRetry !== "function")))
  ) {
    return memoryExecutionFailure("memory_execution_input_invalid");
  }
  const execution = {
    admission: createPrismaMemoryExecutionAdmission(input.authority, input.client),
    lifecycle: createPrismaMemoryExecutionLifecycle(input.authority, input.client)
  };
  const ordinals = [input.ordinal];
  let outcome = await executeGovernedAttempt(input, execution, input.ordinal);
  for (let attempt = 1; retry && outcome.kind === "output_invalid" && attempt < maxAttempts; attempt += 1) {
    if (input.signal.aborted ||
      await settledInvalidOutputs(input) >= MEMORY_STRUCTURED_OUTPUT_INVALID_OUTPUT_BREAKER) break;
    await retry.beforeRetry?.(attempt);
    const ordinal = await retry.allocateOrdinal(attempt);
    if (!Number.isSafeInteger(ordinal) || ordinals.includes(ordinal)) {
      return memoryExecutionFailure("memory_execution_input_invalid");
    }
    ordinals.push(ordinal);
    logEvent("service_operation", {
      subsystem: "memory", stage: "validate", outcome: "failed", action: "retry",
      code: OUTPUT_INVALID_CODE, attempt,
      ...(input.owner.type === "JOB" ? { job_id: input.owner.memoryJobId } : {})
    });
    outcome = await executeGovernedAttempt(input, execution, ordinal);
  }
  if (outcome.kind === "succeeded") return outcome.result;
  throw outcome.error;
}

export async function probeMemoryStructuredOutputAuthority(input: Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  client: PrismaClient;
  role: MemoryExecutionRole;
  userId: string;
  versions: MemoryExecutionVersions;
}>): Promise<void> {
  await withLockedMemoryTransaction(
    input.client,
    input.userId,
    async (tx, settings) => {
      const resolved = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
        dependencies: input.authority,
        now: memoryExecutionNow(input.authority),
        role: input.role,
        userId: input.userId,
        versions: input.versions
      });
      const model = resolved.target.snapshot.model;
      const requiredMode = memoryRoleRequiresForcedToolCall(input.role)
        ? resolveProviderToolChoice({ adapterKind: model.adapterKind, modelId: model.upstreamModelId,
          modelCapabilities: model.capabilities, params: model.defaultParams, toolChoice: "required" }).requirementMode
        : null;
      if (
        model.adapterKind === "fake" ||
        model.modelClass !== "answer" ||
        (memoryRoleRequiresForcedToolCall(input.role)
          ? requiredMode === "native"
            ? model.capabilities.forcedToolCalling !== true
            : model.capabilities.validatedAutoToolCalling !== true
          : model.capabilities.structuredOutput !== true ||
            !supportsStructuredOutputAdapter(model.adapterKind))
      ) {
        throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    }
  );
}

export { memoryReportedUsage } from "./usage";
