import { createHash } from "node:crypto";

export type SearchProbeBinding = Readonly<{
  connectionId: string;
  connectionVersion: number;
  credentialId: string;
  credentialVersionId: string;
  modelVersion: number;
  providerModelId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Parse the non-secret authority tuple that actually produced source-bearing
 * Search evidence. This value is server-only and must not enter catalog or
 * administrator client contracts. */
export function searchProbeBinding(value: unknown): SearchProbeBinding | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.probeBinding) ? value.probeBinding : value;
  return identifier(candidate.connectionId) && version(candidate.connectionVersion) &&
    identifier(candidate.credentialId) && identifier(candidate.credentialVersionId) &&
    version(candidate.modelVersion) && identifier(candidate.providerModelId)
    ? {
        connectionId: candidate.connectionId,
        connectionVersion: candidate.connectionVersion,
        credentialId: candidate.credentialId,
        credentialVersionId: candidate.credentialVersionId,
        modelVersion: candidate.modelVersion,
        providerModelId: candidate.providerModelId
      }
    : null;
}

export function sameSearchProbeBinding(
  left: SearchProbeBinding,
  right: SearchProbeBinding
): boolean {
  return left.connectionId === right.connectionId &&
    left.connectionVersion === right.connectionVersion &&
    left.credentialId === right.credentialId &&
    left.credentialVersionId === right.credentialVersionId &&
    left.modelVersion === right.modelVersion &&
    left.providerModelId === right.providerModelId;
}

export function withSearchProbeBinding(
  evidence: Record<string, unknown>,
  binding: SearchProbeBinding
): Record<string, unknown> {
  return { ...evidence, probeBinding: binding };
}

export function searchValidationFingerprint(value: unknown): string {
  const binding = searchProbeBinding(value);
  const identity = binding
    ? [
        binding.connectionId,
        binding.connectionVersion,
        binding.credentialId,
        binding.credentialVersionId,
        binding.modelVersion,
        binding.providerModelId
      ]
    : ["configuration"];
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}
