import {
  defaultProviderModels,
  resolveProviderModelParameterControls,
  type CatalogAdapterKind
} from "../../domain/catalog";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import type { ProviderModelCapabilities } from "./types";

type ProviderModelCapabilityResolution = Readonly<{
  adapterKind: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  providerFamily: string;
  upstreamModelId: string;
}>;

export function configuredModelParameterControls(
  configuration: ProviderModelConfiguration,
  providerFamily: string
) {
  const adapterKind = configuration.adapterKind as CatalogAdapterKind;
  const capabilities = resolveProviderModelCapabilities({
    adapterKind,
    capabilities: configuration.capabilities,
    providerFamily,
    upstreamModelId: configuration.upstreamModelId
  });
  return resolveProviderModelParameterControls({
    adapterKind,
    defaultMaxOutputTokens: capabilities.defaultMaxOutputTokens,
    defaultReasoningEffort: capabilities.defaultReasoningEffort,
    defaultReasoningMode: capabilities.defaultReasoningMode,
    defaultParams: configuration.defaultParams,
    providerFamily,
    reasoningEfforts: capabilities.reasoningEfforts,
    reasoningModes: capabilities.reasoningModes,
    supportsReasoningMode: "reasoningRequestMapping" in configuration &&
      Boolean(configuration.reasoningRequestMapping?.modePath),
    supportsReasoning: capabilities.reasoning,
    supportsStreaming: capabilities.streaming ?? false,
    upstreamModelId: configuration.upstreamModelId
  });
}

export function resolveProviderModelCapabilities(
  input: ProviderModelCapabilityResolution
): ProviderModelCapabilities {
  const template = defaultProviderModels.find(
    (model) =>
      model.adapterKind === input.adapterKind &&
      model.providerFamily === input.providerFamily &&
      model.upstreamModelId === input.upstreamModelId
  );
  const templateContextWindow = typeof template?.contextWindow === "number"
    ? template.contextWindow
    : undefined;
  const contextWindow = input.capabilities.contextWindow ?? templateContextWindow;

  return {
    ...input.capabilities,
    // Text extraction is provided by AIQSA before answer-provider execution.
    // It is therefore available for every answer deployment independently of
    // the provider's separately verified Direct PDF capability.
    pdf: true,
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}
