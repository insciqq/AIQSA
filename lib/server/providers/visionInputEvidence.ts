import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";

type Evidence = NonNullable<AdminProviderTestEvidence["visionInput"]>;
const adapters: readonly string[] = [
  "anthropic_messages", "deepseek_responses_native", "gemini_interactions_native",
  "openai_chat_completions_compatible", "openai_responses_compatible",
  "openai_responses_native", "openrouter_chat_completions"
];

export function decodeVisionInputVerificationEvidence(value: unknown): Evidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.probeVersion !== 1 || item.verified !== true ||
    typeof item.adapterKind !== "string" || !adapters.includes(item.adapterKind) ||
    typeof item.upstreamModelId !== "string" || !item.upstreamModelId.trim() ||
    item.upstreamModelId !== item.upstreamModelId.trim() ||
    item.upstreamModelId.length > 512) return null;
  return {
    adapterKind: item.adapterKind as Evidence["adapterKind"],
    probeVersion: 1,
    upstreamModelId: item.upstreamModelId,
    verified: true
  };
}

/** The caller must first select a successful check for the exact active
 * connection/model/credential versions. A declared capability is insufficient. */
export function hasVerifiedVisionInput(evidence: unknown, model: Readonly<{
  adapterKind: string;
  capabilities: Readonly<{ vision: boolean }>;
  upstreamModelId: string;
}>): boolean {
  if (!model.capabilities.vision || typeof evidence !== "object" || evidence === null) {
    return false;
  }
  const verified = decodeVisionInputVerificationEvidence(
    (evidence as Record<string, unknown>).visionInput
  );
  return verified?.adapterKind === model.adapterKind &&
    verified.upstreamModelId === model.upstreamModelId;
}
