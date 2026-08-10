import type { MemoryRebuildOperation } from "../../../contracts/memory";
import type { MemoryJobDescriptor } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_SHADOW_REBUILD_PIPELINE_VERSION =
  "memory-shadow-rebuild-v1";
export const MEMORY_REDREAM_BATCH_PIPELINE_VERSION =
  "memory-redream-batch-v1";

const shadowPrefix = "memory-shadow-rebuild-v1:";
const redreamPrefix = "memory-redream-v1:";
const uuidPattern =
  "([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})";
const hashPattern = "([a-f0-9]{64})";
const shadowPattern = new RegExp(
  `^${shadowPrefix}([re]):${uuidPattern}:${hashPattern}$`,
  "u"
);
const redreamPattern = new RegExp(
  `^${redreamPrefix}${uuidPattern}:${hashPattern}$`,
  "u"
);

export type MemoryShadowRebuildOperation =
  | "REBUILD_SEARCH_INDEX"
  | "REEMBED";

export type MemoryRebuildJobIdentity =
  | Readonly<{
      generationId: string;
      operation: MemoryShadowRebuildOperation;
      requestHash: string;
      type: "SHADOW";
    }>
  | Readonly<{
      batchId: string;
      operation: "REDREAM_EXISTING_CHATS";
      requestHash: string;
      type: "REDREAM";
    }>;

function operationCode(operation: MemoryShadowRebuildOperation): "e" | "r" {
  return operation === "REEMBED" ? "e" : "r";
}

export function memoryShadowRebuildJobFingerprint(input: Readonly<{
  generationId: string;
  operation: MemoryShadowRebuildOperation;
  requestIdentity: unknown;
}>): string {
  const fingerprint = `${shadowPrefix}${operationCode(input.operation)}:${input.generationId}:${memorySha256({
    domain: "aiqsa.memory.shadow-rebuild-request",
    generationId: input.generationId,
    operation: input.operation,
    requestIdentity: input.requestIdentity,
    version: "v1"
  })}`;
  if (fingerprint.length > 128 || !shadowPattern.test(fingerprint)) {
    throw new Error("memory_rebuild_job_identity_invalid");
  }
  return fingerprint;
}

export function memoryRedreamBatchJobFingerprint(input: Readonly<{
  batchId: string;
  requestIdentity: unknown;
}>): string {
  const fingerprint = `${redreamPrefix}${input.batchId}:${memorySha256({
    batchId: input.batchId,
    domain: "aiqsa.memory.redream-batch-request",
    requestIdentity: input.requestIdentity,
    version: "v1"
  })}`;
  if (fingerprint.length > 128 || !redreamPattern.test(fingerprint)) {
    throw new Error("memory_redream_job_identity_invalid");
  }
  return fingerprint;
}

export function parseMemoryRebuildJobFingerprint(
  value: string
): MemoryRebuildJobIdentity | null {
  const shadow = shadowPattern.exec(value);
  if (shadow) {
    return {
      generationId: shadow[2]!,
      operation: shadow[1] === "e" ? "REEMBED" : "REBUILD_SEARCH_INDEX",
      requestHash: shadow[3]!,
      type: "SHADOW"
    };
  }
  const redream = redreamPattern.exec(value);
  return redream
    ? {
        batchId: redream[1]!,
        operation: "REDREAM_EXISTING_CHATS",
        requestHash: redream[2]!,
        type: "REDREAM"
      }
    : null;
}

export function memoryShadowRebuildJobPrefixes(generationId: string): readonly string[] {
  return Object.freeze([
    `${shadowPrefix}r:${generationId}:`,
    `${shadowPrefix}e:${generationId}:`
  ]);
}

export function memoryRebuildJobClaimIsValid(
  job: MemoryJobDescriptor
): job is MemoryJobDescriptor & Readonly<{ kind: "REBUILD_INDEX" }> {
  const identity = parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint);
  if (!identity || job.kind !== "REBUILD_INDEX") return false;
  const expectedPipeline = identity.type === "SHADOW"
    ? MEMORY_SHADOW_REBUILD_PIPELINE_VERSION
    : MEMORY_REDREAM_BATCH_PIPELINE_VERSION;
  return job.pipelineVersion === expectedPipeline &&
    job.chatId === null &&
    job.activeLeafMessageId === null &&
    job.branchGeneration === null &&
    job.sourceRevision === null &&
    job.sourceHash === null;
}

export function memoryRebuildOperationFromJob(
  job: Pick<MemoryJobDescriptor, "idempotencyFingerprint">
): MemoryRebuildOperation | null {
  return parseMemoryRebuildJobFingerprint(job.idempotencyFingerprint)?.operation ?? null;
}
