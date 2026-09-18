import { resolveOpenRouterNativeProvider, type NativeProviderResolution } from "../../../domain/openRouterNativeRouting";
import { maxOutputTokensFromParams } from "../../../domain/providerParams";
import type { OpenRouterDiscoveryClient } from "../../providers/openRouterDiscovery";
import { normalizeProviderModelConfiguration, type ProviderModelConfiguration } from "../../providers/providerConfiguration";
import type { AdminProviderCapabilityCheck, AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { NativeRouteAdoptionDiagnostic } from "../../../contracts/nativeRoutingAdoption";
import { reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import { hasVerifiedDedicatedProtocol } from "../../providers/systemRoleEvidence";
import { capabilityFailureAttempt } from "./capabilityProbeFailure";

export type NativeRouteDiscovery = (NativeProviderResolution | { available: false; reason: "verification_required" }) & {
  diagnostic?: NativeRouteAdoptionDiagnostic;
};

const configuredChecks = { toolCalling: "toolCalling", parallelToolCalls: "parallelToolCalls", vision: "vision",
  nativePdfInput: "directPdf", streaming: "streaming", nativeSearch: "hostedSearch",
  imageGeneration: "imageGeneration", imageEditing: "imageEditing" } as const;

function configuredCapabilities(model: ProviderModelConfiguration): AdminProviderCapabilityCheck[] {
  return Object.entries(configuredChecks).flatMap(([capability, check]) =>
    model.capabilities[capability as keyof typeof configuredChecks] === true ? [check] : []);
}

function requiredCapabilities(model: ProviderModelConfiguration, previous?: AdminProviderTestEvidence): AdminProviderCapabilityCheck[] {
  const before = reusableCapabilitySetupEvidence(previous, model);
  return [...new Set<AdminProviderCapabilityCheck>(["modelAccess", ...configuredCapabilities(model),
    ...Object.entries(before?.capabilitySetup?.checks ?? {}).flatMap(([check, status]) =>
      status === "verified" ? [check as AdminProviderCapabilityCheck] : [])])];
}

export function nativeRoutePreviouslyUnverified(model: ProviderModelConfiguration, previous?: AdminProviderTestEvidence): AdminProviderCapabilityCheck[] {
  const before = reusableCapabilitySetupEvidence(previous, model);
  return configuredCapabilities(model).filter((check) => before?.capabilitySetup?.checks[check] !== "verified");
}

export async function discoverNativeRoute(
  client: Pick<OpenRouterDiscoveryClient, "listModelEndpoints">,
  model: ProviderModelConfiguration,
  signal?: AbortSignal,
  previous?: AdminProviderTestEvidence
): Promise<NativeRouteDiscovery> {
  try {
    const endpoints = await client.listModelEndpoints(model.upstreamModelId, { signal });
    const required = requiredCapabilities(model, previous);
    const route = resolveOpenRouterNativeProvider({
      modelId: model.upstreamModelId, endpoints,
      requiredParameters: required.some((check) => ["toolCalling", "parallelToolCalls", "forcedToolCall"].includes(check)) ? ["tools"] : [],
      maxOutputTokens: maxOutputTokensFromParams(model.defaultParams),
      requireForcedToolChoice: required.includes("forcedToolCall")
    });
    if (route.available) return route;
    const mismatch = route.mismatch;
    const missing: NativeRouteAdoptionDiagnostic["missing"] = [
      ...(mismatch?.missingParameters.includes("tools") ? required.filter((check) => ["toolCalling", "parallelToolCalls", "forcedToolCall"].includes(check)) : []),
      ...(mismatch?.outputLimit !== undefined ? ["maxOutputTokens" as const] : []),
      ...(mismatch?.forcedToolChoice ? ["forcedToolCall" as const] : [])
    ];
    return { ...route, diagnostic: { version: 1, stage: "catalog", code: route.reason, servingMode: "automatic",
      ...(mismatch ? { provider: mismatch.provider } : {}), missing: [...new Set(missing)],
      previouslyUnverified: nativeRoutePreviouslyUnverified(model, previous) } };
  } catch (error) {
    signal?.throwIfAborted();
    const failure = capabilityFailureAttempt(error, { attempts: 1, capability: "modelAccess",
      adapterKind: model.adapterKind, accessVerified: false, timedOut: false });
    return { available: false, reason: "verification_required", diagnostic: {
      version: 1, stage: "catalog", code: failure.reason, servingMode: "automatic", missing: [],
      previouslyUnverified: nativeRoutePreviouslyUnverified(model, previous),
      ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {})
    } };
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
  return nativeRouteMissingCapabilities(model, previous, fresh).length === 0;
}

export function nativeRouteMissingCapabilities(model: ProviderModelConfiguration,
  previous: AdminProviderTestEvidence | undefined, fresh: AdminProviderTestEvidence): AdminProviderCapabilityCheck[] {
  if (model.modelClass === "embedding" || model.modelClass === "reranker") return hasVerifiedDedicatedProtocol(fresh, model)
    ? [] : [model.modelClass === "embedding" ? "embedding" : "reranking"];
  const after = reusableCapabilitySetupEvidence(fresh, model);
  return requiredCapabilities(model, previous).filter((check) => after?.capabilitySetup?.checks[check] !== "verified");
}
