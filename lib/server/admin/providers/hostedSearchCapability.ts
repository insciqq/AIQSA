import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { ProviderConnectionConfiguration, ProviderModelConfiguration } from "../../providers/providerConfiguration";

type Evidence = NonNullable<AdminProviderTestEvidence["hostedSearch"]>;

/** Catalog detection selects a probe, never publishes capability evidence.
 * Explicit routing isolation does not identify a gateway. */
export function shouldProbeHostedSearch(model: ProviderModelConfiguration,
  connection?: Pick<ProviderConnectionConfiguration, "responsesRequestIsolationDetected">
): boolean {
  return model.modelClass === "answer" && model.adapterKind === "openai_responses_compatible" &&
    (model.capabilities.nativeSearch || connection?.responsesRequestIsolationDetected === true);
}

export function decodeHostedSearchVerificationEvidence(value: unknown): Evidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.adapterKind !== "openai_responses_compatible" || item.probeVersion !== 1 || item.verified !== true ||
    typeof item.upstreamModelId !== "string" || !item.upstreamModelId.trim() ||
    item.upstreamModelId !== item.upstreamModelId.trim() || item.upstreamModelId.length > 512 ||
    !Number.isSafeInteger(item.normalizedSourceCount) || Number(item.normalizedSourceCount) < 1 ||
    Number(item.normalizedSourceCount) > 20) return null;
  return { adapterKind: "openai_responses_compatible", normalizedSourceCount: Number(item.normalizedSourceCount),
    probeVersion: 1, upstreamModelId: item.upstreamModelId, verified: true };
}
