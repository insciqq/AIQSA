import type { CatalogAdapterKind } from "../../domain/catalog";
import {
  supportsStructuredOutputAdapter,
  type StructuredOutputAdapterKind
} from "./structuredOutput";

export type StructuredOutputVerificationEvidence = Readonly<{
  adapterKind: StructuredOutputAdapterKind;
  probeVersion: 2;
  upstreamModelId: string;
  verified: true;
}>;

export type StructuredOutputVerificationStatus =
  | "not_verified"
  | "unsupported"
  | "verified";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function structuredOutputVerificationEvidence(
  adapterKind: CatalogAdapterKind | string,
  upstreamModelId: string
): StructuredOutputVerificationEvidence | null {
  return supportsStructuredOutputAdapter(adapterKind) && upstreamModelId.trim()
    ? {
        adapterKind,
        probeVersion: 2,
        upstreamModelId: upstreamModelId.trim(),
        verified: true
      }
    : null;
}

export function decodeStructuredOutputVerificationEvidence(
  value: unknown
): StructuredOutputVerificationEvidence | null {
  if (
    !isRecord(value) ||
    value.verified !== true ||
    value.probeVersion !== 2 ||
    typeof value.adapterKind !== "string" ||
    !supportsStructuredOutputAdapter(value.adapterKind) ||
    typeof value.upstreamModelId !== "string" ||
    !value.upstreamModelId.trim() ||
    value.upstreamModelId.length > 512
  ) return null;
  return {
    adapterKind: value.adapterKind,
    probeVersion: 2,
    upstreamModelId: value.upstreamModelId,
    verified: true
  };
}

export function hasVerifiedStructuredOutput(
  evidence: unknown,
  model: Readonly<{ adapterKind: CatalogAdapterKind | string; upstreamModelId: string }>
): boolean {
  if (!isRecord(evidence)) return false;
  const verification = decodeStructuredOutputVerificationEvidence(
    evidence.structuredOutput
  );
  return verification?.adapterKind === model.adapterKind &&
    verification.upstreamModelId === model.upstreamModelId;
}

export function structuredOutputVerificationStatus(
  evidence: unknown,
  model: Readonly<{ adapterKind: CatalogAdapterKind | string; upstreamModelId: string }>
): StructuredOutputVerificationStatus {
  if (!supportsStructuredOutputAdapter(model.adapterKind)) return "unsupported";
  return hasVerifiedStructuredOutput(evidence, model) ? "verified" : "not_verified";
}
