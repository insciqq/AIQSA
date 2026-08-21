import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../../domain/usage";
import { createAcceptedStructuredOutputSnapshotExecutor } from
  "../../providerRuntime/structuredOutputExecutor";
import type { ProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import type {
  ProviderStructuredOutputRequest
} from "../../providers/structuredOutput";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import {
  memoryExecutionNow,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies
} from "./authority";
import { createPrismaMemoryExecutionAdmission } from "./admission";
import { memoryExecutionSha256 } from "./canonical";
import type { MemoryExecutionVersions } from "./compatibility";
import { MemoryExecutionError } from "./errors";
import {
  createPrismaMemoryExecutionLifecycle,
  type MemoryReportedUsage
} from "./lifecycle";
import type { MemoryExecutionOwner } from "./owner";
import type { MemoryExecutionRole } from "./roles";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { withLockedMemoryTransaction } from "../persistence/transaction";

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
  constructor(
    readonly providerResponseId: string | null,
    readonly usage: ModelRunUsage | null,
    options: Readonly<{ cause?: unknown }> = {}
  ) {
    super("memory_structured_output_provider_failed", options);
    this.name = "MemoryStructuredOutputProviderError";
  }
}

export const unavailableMemoryReportedUsage: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});

export function memoryReportedUsage(
  value: ModelRunUsage | null
): MemoryReportedUsage {
  if (value === null) return unavailableMemoryReportedUsage;
  const usage = normalizeTokenUsage(value);
  return {
    cachedInputTokens: usage.cachedInputTokens,
    completeness: "COMPLETE",
    estimatedCostMicros: null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens
  };
}

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
        const output = await execute(
          snapshot.providerExecutionSnapshot,
          {
            ...request,
            reasoningEffort: request.reasoningEffort ?? reasoningEffort(snapshot)
          },
          {
            onProviderResponseId: (value) => { providerResponseId = value; },
            onUsage: (value) => { usage = value; },
            signal,
            timeoutMs: 15_000
          }
        );
        return { output, providerResponseId, usage };
      } catch (error) {
        throw new MemoryStructuredOutputProviderError(
          providerResponseId,
          usage,
          { cause: error }
        );
      }
    }
  });
}

export async function executeGovernedMemoryStructuredOutput<Value>(input: Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  client: PrismaClient;
  decode(value: unknown): Value;
  inputHash: string;
  ordinal: number;
  owner: MemoryExecutionOwner;
  provider: MemoryStructuredOutputProvider;
  request: ProviderStructuredOutputRequest;
  role: MemoryExecutionRole;
  signal: AbortSignal;
  userId: string;
  versions: MemoryExecutionVersions;
}>): Promise<GovernedMemoryStructuredOutput<Value>> {
  const execution = {
    admission: createPrismaMemoryExecutionAdmission(input.authority, input.client),
    lifecycle: createPrismaMemoryExecutionLifecycle(input.authority, input.client)
  };
  const binding = await execution.admission.bind(input.userId, {
    inputHash: input.inputHash,
    ordinal: input.ordinal,
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
    const failure = error instanceof MemoryStructuredOutputProviderError
      ? error
      : null;
    await execution.lifecycle.settle(input.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: input.signal.aborted
        ? "memory_classifier_cancelled"
        : "memory_classifier_provider_unavailable",
      providerResponseId: failure?.providerResponseId ?? null,
      state: input.signal.aborted ? "CANCELLED" : "FAILED",
      usage: memoryReportedUsage(failure?.usage ?? null)
    });
    throw error;
  }

  let value: Value;
  try {
    value = input.decode(providerResult.output);
  } catch (error) {
    await execution.lifecycle.settle(input.userId, binding.id, {
      acceptedOutputHash: null,
      errorCode: "memory_classifier_output_invalid",
      providerResponseId: providerResult.providerResponseId,
      state: "FAILED",
      usage: memoryReportedUsage(providerResult.usage)
    });
    throw error;
  }
  const acceptedOutputHash = memoryExecutionSha256({
    inputHash: input.inputHash,
    output: value,
    role: input.role,
    version: 1
  });
  const settled = await execution.lifecycle.settle(input.userId, binding.id, {
    acceptedOutputHash,
    errorCode: null,
    providerResponseId: providerResult.providerResponseId,
    state: "SUCCEEDED",
    usage: memoryReportedUsage(providerResult.usage)
  });
  const provider = started.snapshot.providerExecutionSnapshot;
  return {
    acceptedOutputHash,
    bindingId: binding.id,
    classifiedAt: settled.completedAt,
    inputHash: input.inputHash,
    modelId: provider.providerModelId,
    policyVersion: input.versions.policyVersion,
    providerId: provider.providerFamily,
    value
  };
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
      if (
        model.adapterKind === "fake" ||
        model.modelClass !== "answer" ||
        model.capabilities.structuredOutput !== true ||
        !supportsStructuredOutputAdapter(model.adapterKind)
      ) {
        throw new MemoryExecutionError("memory_execution_capability_unavailable");
      }
    }
  );
}
