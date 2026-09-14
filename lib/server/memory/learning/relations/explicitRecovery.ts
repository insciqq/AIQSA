import { memoryExecutionSha256 } from "../../execution/canonical";
import { isValidMemoryExecutionIdentifier } from "../../execution/owner";
import {
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  memoryExplicitRelationRef,
  memoryExplicitRelationSnapshotHash,
  selectMemoryExplicitRelationMerge,
  type MemoryExplicitRelationDecision,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";
import { memoryExplicitRelationInputHash } from "./explicitResolver";

export const MEMORY_EXPLICIT_RELATION_RECOVERY_VERSION = "memory-explicit-relation-recovery-v1";

/** Only immutable identities, hashes and closed decisions are retained here.
 * Recovery reloads original facts through current owner/lifecycle authority;
 * this packet is never a second copy of source text or an authority grant. */
export type MemoryExplicitRelationRecoveryPacket = Readonly<{
  candidateVersionIds: readonly string[];
  decisions: readonly MemoryExplicitRelationDecision[];
  inputHash: string;
  outputHash: string;
  schemaVersion: typeof MEMORY_EXPLICIT_RELATION_RECOVERY_VERSION;
  snapshotHash: string;
  sourceVersionId: string;
}>;

type ExpectedRecovery = Readonly<{
  acceptedOutputHash: string;
  inputHash: string;
  sourceVersionId: string;
}>;

const sha256 = /^[a-f0-9]{64}$/u;

function invalid(): never {
  throw new Error("memory_explicit_relation_recovery_invalid");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function memoryExplicitRelationOutputHash(
  inputHash: string,
  decisions: readonly MemoryExplicitRelationDecision[]
): string {
  return memoryExecutionSha256({
    inputHash, output: decisions, role: "MEMORY_CONSOLIDATE", version: 1
  });
}

export function decodeMemoryExplicitRelationRecovery(
  value: unknown,
  expected: ExpectedRecovery
): MemoryExplicitRelationRecoveryPacket {
  if (!isValidMemoryExecutionIdentifier(expected.sourceVersionId) ||
    !sha256.test(expected.inputHash) || !sha256.test(expected.acceptedOutputHash) ||
    !record(value) || Object.keys(value).sort().join() !==
      "candidateVersionIds,decisions,inputHash,outputHash,schemaVersion,snapshotHash,sourceVersionId" ||
    value.schemaVersion !== MEMORY_EXPLICIT_RELATION_RECOVERY_VERSION ||
    value.sourceVersionId !== expected.sourceVersionId ||
    value.inputHash !== expected.inputHash || value.outputHash !== expected.acceptedOutputHash ||
    typeof value.snapshotHash !== "string" || !sha256.test(value.snapshotHash) ||
    !Array.isArray(value.candidateVersionIds) || !Array.isArray(value.decisions) ||
    value.candidateVersionIds.length < 1 ||
    value.candidateVersionIds.length > MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES ||
    value.decisions.length !== value.candidateVersionIds.length) return invalid();
  const candidateVersionIds = value.candidateVersionIds.map((id) => {
    if (!isValidMemoryExecutionIdentifier(id) || id === expected.sourceVersionId) return invalid();
    return id;
  });
  if (new Set(candidateVersionIds).size !== candidateVersionIds.length) return invalid();
  const refs = candidateVersionIds.map((_, index) => memoryExplicitRelationRef(index));
  const decoded = value.decisions.map((item): MemoryExplicitRelationDecision => {
    if (!record(item) || Object.keys(item).sort().join() !== "confidenceBand,relation,targetRef" ||
      typeof item.targetRef !== "string" || !refs.includes(item.targetRef) ||
      (item.confidenceBand !== "HIGH" && item.confidenceBand !== "MEDIUM" && item.confidenceBand !== "LOW") ||
      (item.relation !== "EQUIVALENT" && item.relation !== "DISTINCT" && item.relation !== "UNCERTAIN")) {
      return invalid();
    }
    return Object.freeze({
      confidenceBand: item.confidenceBand, relation: item.relation, targetRef: item.targetRef
    });
  });
  if (new Set(decoded.map(({ targetRef }) => targetRef)).size !== refs.length) return invalid();
  const decisions = refs.map((ref) => decoded.find(({ targetRef }) => targetRef === ref)!);
  if (memoryExplicitRelationOutputHash(expected.inputHash, decisions) !== expected.acceptedOutputHash) {
    return invalid();
  }
  return Object.freeze({
    candidateVersionIds: Object.freeze(candidateVersionIds),
    decisions: Object.freeze(decisions),
    inputHash: expected.inputHash,
    outputHash: expected.acceptedOutputHash,
    schemaVersion: MEMORY_EXPLICIT_RELATION_RECOVERY_VERSION,
    snapshotHash: value.snapshotHash,
    sourceVersionId: expected.sourceVersionId
  });
}

export function createMemoryExplicitRelationRecovery(
  snapshot: MemoryExplicitRelationSnapshot,
  decisions: readonly MemoryExplicitRelationDecision[],
  acceptedOutputHash: string
): MemoryExplicitRelationRecoveryPacket {
  selectMemoryExplicitRelationMerge(snapshot, decisions);
  const inputHash = memoryExplicitRelationInputHash(snapshot);
  return decodeMemoryExplicitRelationRecovery({
    candidateVersionIds: snapshot.candidates.map(({ versionId }) => versionId),
    decisions,
    inputHash,
    outputHash: acceptedOutputHash,
    schemaVersion: MEMORY_EXPLICIT_RELATION_RECOVERY_VERSION,
    snapshotHash: memoryExplicitRelationSnapshotHash(snapshot),
    sourceVersionId: snapshot.source.versionId
  }, { acceptedOutputHash, inputHash, sourceVersionId: snapshot.source.versionId });
}

export function assertMemoryExplicitRelationRecoverySnapshot(
  packet: MemoryExplicitRelationRecoveryPacket,
  snapshot: MemoryExplicitRelationSnapshot
): void {
  const decoded = decodeMemoryExplicitRelationRecovery(packet, {
    acceptedOutputHash: packet.outputHash,
    inputHash: packet.inputHash,
    sourceVersionId: packet.sourceVersionId
  });
  if (decoded.inputHash !== memoryExplicitRelationInputHash(snapshot) ||
    decoded.sourceVersionId !== snapshot.source.versionId ||
    decoded.snapshotHash !== memoryExplicitRelationSnapshotHash(snapshot) ||
    decoded.candidateVersionIds.some((id, index) => id !== snapshot.candidates[index]?.versionId) ||
    decoded.candidateVersionIds.length !== snapshot.candidates.length) {
    throw new Error("memory_explicit_relation_snapshot_stale");
  }
}
