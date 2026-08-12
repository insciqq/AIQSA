import type { MemoryDeletionOperation } from "@prisma/client";

export const MEMORY_PHASE2_PURGE_MANIFEST_VERSION = "memory-p7-purge-v3";
export const MEMORY_DELETE_EXPLICIT_TARGET_ID = "all-explicit";

export const MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS = Object.freeze([
  Object.freeze({ id: "unaccepted-attempts", version: "v1" }),
  Object.freeze({ id: "history-derivatives", version: "v1" }),
  Object.freeze({ id: "candidate-derivatives", version: "v1" }),
  Object.freeze({ id: "feedback-records", version: "v1" }),
  Object.freeze({ id: "fact-search", version: "v1" }),
  Object.freeze({ id: "profile-projections", version: "v1" }),
  Object.freeze({ id: "fact-version-content", version: "v1" }),
  Object.freeze({ id: "all-reusable-ledger", version: "v1" }),
  Object.freeze({ id: "fact-evidence", version: "v1" }),
  Object.freeze({ id: "all-reusable-work", version: "v1" }),
  Object.freeze({ id: "all-reusable-indexes", version: "v1" })
]);

export type MemoryPurgeTargetKind =
  | "ALL_REUSABLE"
  | "AUTOMATIC_SET"
  | "EXPLICIT_SET"
  | "MEMORY_FACT";

export type MemoryPurgeTarget = Readonly<{
  kind: MemoryPurgeTargetKind;
  manifestVersion: string;
  operation: MemoryDeletionOperation;
  targetId: string;
  targetType: string;
  userId: string;
}>;

const manifestVersionPattern = /^[a-z][a-z0-9._-]{0,47}$/u;
const factIdPattern = /^\S{1,256}$/u;

export function memoryPurgeTargetType(
  kind: MemoryPurgeTargetKind,
  manifestVersion = MEMORY_PHASE2_PURGE_MANIFEST_VERSION
): string {
  if (!manifestVersionPattern.test(manifestVersion)) {
    throw new Error("memory_purge_manifest_version_invalid");
  }
  return `${kind}@${manifestVersion}`;
}

export function parseMemoryPurgeTarget(input: Readonly<{
  operation: MemoryDeletionOperation;
  targetId: string;
  targetType: string;
  userId: string;
}>): MemoryPurgeTarget | null {
  if (input.operation !== "FORGET_PURGE") return null;
  const match = /^(ALL_REUSABLE|AUTOMATIC_SET|EXPLICIT_SET|MEMORY_FACT)@([a-z][a-z0-9._-]{0,47})$/u.exec(
    input.targetType
  );
  if (!match || !factIdPattern.test(input.userId)) return null;
  const kind = match[1] as MemoryPurgeTargetKind;
  if (
    (kind === "EXPLICIT_SET" && input.targetId !== MEMORY_DELETE_EXPLICIT_TARGET_ID) ||
    (kind === "ALL_REUSABLE" && !factIdPattern.test(input.targetId)) ||
    (kind === "AUTOMATIC_SET" && !factIdPattern.test(input.targetId)) ||
    (kind === "MEMORY_FACT" && !factIdPattern.test(input.targetId))
  ) {
    return null;
  }
  return {
    ...input,
    kind,
    manifestVersion: match[2]!
  };
}
