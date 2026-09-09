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

export function supportsConfiguredReasoningEffort(
  configuration: Parameters<typeof configuredModelParameterControls>[0],
  providerFamily: string,
  effort: string
): boolean {
  const control = configuredModelParameterControls(configuration, providerFamily).reasoningEffort;
  return control.supported && control.options.includes(effort);
}

/** Cheap probes still have to use a reasoning level the deployment supports. */
export function lowestConfiguredReasoningEffort(
  configuration: ProviderModelConfiguration,
  providerFamily: string
): string {
  const controls = configuredModelParameterControls(configuration, providerFamily).reasoningEffort;
  if (!controls.supported) return "none";
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    .find((effort) => controls.options.includes(effort)) ?? controls.defaultValue;
}

export function configuredModelParameterControls(
  configuration: Pick<ProviderModelConfiguration,
    "capabilities" | "defaultParams" | "reasoningRequestMapping" | "upstreamModelId"> & {
      adapterKind: ProviderModelConfiguration["adapterKind"] | "fake";
    },
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
    maxOutputTokens: capabilities.maxOutputTokens,
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

/** A saved exact-model ceiling or a reviewed template ceiling; defaults are not limits. */
export function declaredModelOutputTokenLimit(
  configuration: Pick<ProviderModelConfiguration, "capabilities" | "upstreamModelId"> & {
    adapterKind: ProviderModelConfiguration["adapterKind"] | "fake";
  },
  providerFamily: string
): number | null {
  return configuration.capabilities.maxOutputTokens ?? defaultProviderModels.find((model) =>
    model.adapterKind === configuration.adapterKind && model.providerFamily === providerFamily &&
    model.upstreamModelId === configuration.upstreamModelId
  )?.parameterControls.maxOutputTokens.maxValue ?? null;
}
