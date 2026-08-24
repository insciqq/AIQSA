import type { PrismaClient } from "@prisma/client";
import {
  executeGovernedMemoryStructuredOutput,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionVersions,
  type MemoryStructuredOutputProvider
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createAcceptedMemoryStructuredOutputProvider } from
  "../execution/structuredClassifier";
import {
  buildMemorySynthesisRequest,
  decodeMemorySynthesisOutput,
  type MemorySynthesisOutput
} from "./contract";
import {
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_PROMPT_VERSION,
  MEMORY_SYNTHESIS_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_SYNTHESIS_SCHEMA_VERSION,
  type MemorySynthesisPlan
} from "./policy";

export const MEMORY_SYNTHESIS_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
  policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
  promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
  retrievalConfigFingerprint: MEMORY_SYNTHESIS_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: MEMORY_SYNTHESIS_SCHEMA_VERSION
});

export type MemorySynthesisProviderResult = Readonly<{
  acceptedOutputHash: string;
  executionId: string;
  inputHash: string;
  modelId: string;
  output: MemorySynthesisOutput;
  policyVersion: string;
  providerId: string;
}>;

export type MemorySynthesisProvider = Readonly<{
  synthesize(
    plan: MemorySynthesisPlan,
    signal: AbortSignal,
    execution: Readonly<{ jobId: string; userId: string }>
  ): Promise<MemorySynthesisProviderResult>;
}>;

export function memorySynthesisInputHash(plan: MemorySynthesisPlan): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.synthesis-input",
    sourceSetFingerprint: plan.sourceSetFingerprint,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    versions: MEMORY_SYNTHESIS_VERSIONS
  });
}

export function memorySynthesisAcceptedOutputHash(
  inputHash: string,
  output: MemorySynthesisOutput
): string {
  return memoryExecutionSha256({
    inputHash,
    output,
    role: "MEMORY_SYNTHESIZE",
    version: 1
  });
}

export function createPrismaMemorySynthesisProvider(
  client: PrismaClient,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    provider?: MemoryStructuredOutputProvider;
  }> = {}
): MemorySynthesisProvider {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const provider = options.provider ?? createAcceptedMemoryStructuredOutputProvider(client);
  return Object.freeze({
    async synthesize(plan, signal, execution) {
      const inputHash = memorySynthesisInputHash(plan);
      const governed = await executeGovernedMemoryStructuredOutput({
        authority,
        client,
        decode: (value) => decodeMemorySynthesisOutput(value, plan),
        inputHash,
        ordinal: 0,
        owner: { memoryJobId: execution.jobId, type: "JOB" },
        provider,
        request: buildMemorySynthesisRequest(plan),
        role: "MEMORY_SYNTHESIZE",
        signal,
        userId: execution.userId,
        versions: MEMORY_SYNTHESIS_VERSIONS
      });
      return {
        acceptedOutputHash: governed.acceptedOutputHash,
        executionId: governed.bindingId,
        inputHash: governed.inputHash,
        modelId: governed.modelId,
        output: governed.value,
        policyVersion: governed.policyVersion,
        providerId: governed.providerId
      };
    }
  });
}
