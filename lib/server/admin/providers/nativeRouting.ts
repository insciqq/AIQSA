import { resolveOpenRouterNativeProvider, type NativeProviderResolution } from "../../../domain/openRouterNativeRouting";
import { maxOutputTokensFromParams } from "../../../domain/providerParams";
import type { OpenRouterDiscoveryClient } from "../../providers/openRouterDiscovery";
import { normalizeProviderModelConfiguration, type ProviderModelConfiguration } from "../../providers/providerConfiguration";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { hasVerifiedDedicatedProtocol } from "../../providers/systemRoleEvidence";

export type NativeRouteDiscovery = NativeProviderResolution | { available: false; reason: "verification_required" };

export async function discoverNativeRoute(
  client: Pick<OpenRouterDiscoveryClient, "listModelEndpoints">,
  model: ProviderModelConfiguration,
  signal?: AbortSignal
): Promise<NativeRouteDiscovery> {
  try {
    const endpoints = await client.listModelEndpoints(model.upstreamModelId, { signal });
    return resolveOpenRouterNativeProvider({
      modelId: model.upstreamModelId, endpoints,
      requiredParameters: model.capabilities.toolCalling ? ["tools"] : [],
      maxOutputTokens: maxOutputTokensFromParams(model.defaultParams)
    });
  } catch {
    signal?.throwIfAborted();
    return { available: false, reason: "verification_required" };
  }
}

/** Only for new defaults or the one-time adoption. Operator routes are never
 * inferred from a catalog refresh. Capability probes still run on this route. */
export function applyNativeRoute(
  model: ProviderModelConfiguration,
  route: NativeRouteDiscovery | undefined
): ProviderModelConfiguration {
  if (!route?.available || model.openRouterRouting?.mode !== "automatic") return model;
  return normalizeProviderModelConfiguration({ ...model,
    openRouterRouting: { mode: "only_selected", providers: [route.provider] }
  });
}

export function nativeRoutePreservesCapabilities(model: ProviderModelConfiguration,
  previous: AdminProviderTestEvidence | undefined, fresh: AdminProviderTestEvidence): boolean {
  if (model.modelClass === "embedding" || model.modelClass === "reranker") return hasVerifiedDedicatedProtocol(fresh, model);
  const before = reusableCapabilitySetupEvidence(previous, model);
  const after = reusableCapabilitySetupEvidence(fresh, model);
  if (!after) return false;
  const required = new Set(Object.entries(before?.capabilitySetup?.checks ?? {})
    .filter(([, status]) => status === "verified").map(([key]) => key));
  const configured = { toolCalling: "toolCalling", parallelToolCalls: "parallelToolCalls", vision: "vision",
    nativePdfInput: "directPdf", streaming: "streaming", nativeSearch: "hostedSearch",
    imageGeneration: "imageGeneration", imageEditing: "imageEditing" } as const;
  for (const [capability, check] of Object.entries(configured)) {
    if (model.capabilities[capability as keyof typeof configured] === true) required.add(check);
  }
  return [...required].every((key) => Object.entries(after.capabilitySetup!.checks)
    .some(([check, status]) => check === key && status === "verified"));
}
