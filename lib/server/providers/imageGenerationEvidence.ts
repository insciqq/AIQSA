import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";

type ImageProof = NonNullable<AdminProviderTestEvidence["imageGeneration"]>;
export function decodeImageVerificationEvidence(value: unknown): ImageProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proof = value as Record<string, unknown>;
  if (proof.probeVersion !== 1 || proof.verified !== true || typeof proof.adapterKind !== "string" ||
    !["openai_images_native", "openai_images_compatible", "gemini_images_native", "openrouter_images"].includes(proof.adapterKind) ||
    typeof proof.upstreamModelId !== "string" || !proof.upstreamModelId.trim() || proof.upstreamModelId !== proof.upstreamModelId.trim() ||
    proof.upstreamModelId.length > 256) return null;
  return { adapterKind: proof.adapterKind as ImageProof["adapterKind"], upstreamModelId: proof.upstreamModelId, probeVersion: 1, verified: true };
}

/** Callers fence the connection/model/credential tuple before consulting proof. */
export function hasVerifiedImageCapability(evidence: unknown, model: {
  adapterKind: string; upstreamModelId: string;
  capabilities: { imageGeneration?: boolean; imageEditing?: boolean };
}, capability: "imageGeneration" | "imageEditing"): boolean {
  if (!model.capabilities[capability] || !evidence || typeof evidence !== "object") return false;
  const proof = decodeImageVerificationEvidence((evidence as Record<string, unknown>)[capability]);
  return proof?.adapterKind === model.adapterKind && proof.upstreamModelId === model.upstreamModelId;
}
