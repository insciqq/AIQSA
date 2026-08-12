import type { MemoryJobDescriptor } from "../coordinator/types";
import type { MemoryExecutionVersions } from "../execution";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_TEMPERATURE_FEATURE_VERSION } from "./temperature";

export const MEMORY_PROFILE_PIPELINE_VERSION = "memory-working-set-profile-v1";
export const MEMORY_PROFILE_POLICY_VERSION = "memory-profile-exact-selection-policy-v1";
export const MEMORY_PROFILE_PROMPT_VERSION = "memory-profile-exact-selection-prompt-v1";
export const MEMORY_PROFILE_SCHEMA_VERSION = "memory-profile-exact-selection-schema-v1";
export const MEMORY_PROFILE_PROJECTION_VERSION = "memory-profile-projection-v1";
export const MEMORY_PROFILE_JOB_PREFIX = "memory-profile:";
export const MEMORY_PROFILE_MAX_INPUT_FACTS = 12;
export const MEMORY_PROFILE_MAX_OUTPUT_FACTS = 6;
export const MEMORY_PROFILE_MAX_FACT_TEXT_LENGTH = 500;
export const MEMORY_PROFILE_MAX_SUMMARY_LENGTH = 4_000;

export const MEMORY_PROFILE_RETRIEVAL_CONFIG_FINGERPRINT = memorySha256({
  exactTextOnly: true,
  maxFactTextLength: MEMORY_PROFILE_MAX_FACT_TEXT_LENGTH,
  maxInputFacts: MEMORY_PROFILE_MAX_INPUT_FACTS,
  maxOutputFacts: MEMORY_PROFILE_MAX_OUTPUT_FACTS,
  scope: "GLOBAL_USER",
  temperatureFeatureVersion: MEMORY_TEMPERATURE_FEATURE_VERSION,
  version: 1
});

export const MEMORY_PROFILE_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION,
  policyVersion: MEMORY_PROFILE_POLICY_VERSION,
  promptVersion: MEMORY_PROFILE_PROMPT_VERSION,
  retrievalConfigFingerprint: MEMORY_PROFILE_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: MEMORY_PROFILE_SCHEMA_VERSION
});

export type MemoryProfileLanguage = "en" | "ru";

export type MemoryProfileCandidate = Readonly<{
  factId: string;
  factVersionContentHash: string;
  factVersionId: string;
  safetyIdentitySnapshot: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
  text: string;
  temperatureClass: "COLD" | "HOT" | "WARM";
  temperatureScore: number;
}>;

export type MemoryProfileInput = Readonly<{
  asOf: string;
  candidates: readonly MemoryProfileCandidate[];
  inputHash: string;
  languageCode: MemoryProfileLanguage;
  memoryGeneration: number;
  memoryRevision: number;
  redactionState: "NOT_NEEDED" | "REDACTED";
  safetyIdentitySnapshot: string;
  scopeId: string;
  sourceIdentitySnapshot: string;
  suppressionIdentitySnapshot: string;
}>;

export type MemoryProfileSegment = Readonly<{
  factVersionId: string;
  text: string;
}>;

export type MemoryProfilePlan = Readonly<{
  outputHash: string;
  segments: readonly MemoryProfileSegment[];
}>;

const hashPattern = /^[a-f0-9]{64}$/u;
const profileJobPattern = /^memory-profile:([a-f0-9]{64}):([a-f0-9]{24})$/u;

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export function memoryProfileAsOf(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("memory_profile_time_invalid");
  return new Date(Math.floor(value.getTime() / 3_600_000) * 3_600_000);
}

export function memoryProfileInputHash(
  input: Omit<MemoryProfileInput, "inputHash">
): string {
  const {
    memoryGeneration: _memoryGeneration,
    memoryRevision: _memoryRevision,
    ...providerAndAuthorityInput
  } = input;
  return memorySha256({
    ...providerAndAuthorityInput,
    pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION,
    policyVersion: MEMORY_PROFILE_POLICY_VERSION,
    promptVersion: MEMORY_PROFILE_PROMPT_VERSION,
    schemaVersion: MEMORY_PROFILE_SCHEMA_VERSION
  });
}

export function memoryProfileOutputHash(
  input: MemoryProfileInput,
  segments: readonly MemoryProfileSegment[]
): string {
  return memorySha256({
    inputHash: input.inputHash,
    pipelineVersion: MEMORY_PROFILE_PIPELINE_VERSION,
    segments
  });
}

export function memoryProfileJobFingerprint(inputHash: string, causeId: string): string {
  if (
    !hashPattern.test(inputHash) || causeId.trim() !== causeId ||
    causeId.length < 1 || causeId.length > 256 || /[\u0000-\u001f\u007f]/u.test(causeId)
  ) throw new Error("memory_profile_input_invalid");
  const incarnation = memorySha256({ causeId, inputHash, version: 1 }).slice(0, 24);
  return `${MEMORY_PROFILE_JOB_PREFIX}${inputHash}:${incarnation}`;
}

export function memoryProfileJobInputHash(fingerprint: string): string | null {
  return profileJobPattern.exec(fingerprint)?.[1] ?? null;
}

export function memoryProfileClaimIsValid(job: MemoryJobDescriptor): boolean {
  if (
    job.kind !== "RECALCULATE_WORKING_SET" ||
    job.pipelineVersion !== MEMORY_PROFILE_PIPELINE_VERSION ||
    job.chatId !== null || job.activeLeafMessageId !== null ||
    job.branchGeneration !== null || job.sourceRevision !== null ||
    job.sourceHash !== null ||
    !validCounter(job.memoryGenerationSnapshot) ||
    !validCounter(job.memoryRevisionSnapshot)
  ) return false;
  return memoryProfileJobInputHash(job.idempotencyFingerprint) !== null;
}

export function memoryWorkingSetSweepClaimIsValid(job: MemoryJobDescriptor): boolean {
  return job.kind === "RECALCULATE_WORKING_SET" &&
    job.chatId === null && job.activeLeafMessageId === null &&
    job.branchGeneration === null && job.sourceRevision === null &&
    job.sourceHash === null && validCounter(job.memoryGenerationSnapshot) &&
    validCounter(job.memoryRevisionSnapshot) &&
    !job.idempotencyFingerprint.startsWith(MEMORY_PROFILE_JOB_PREFIX);
}
