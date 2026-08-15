import { defaultProviderModels, type CatalogAdapterKind } from "../../domain/catalog";
import type { ProviderModelCapabilities } from "./types";

type ProviderModelCapabilityResolution = Readonly<{
  adapterKind: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  providerFamily: string;
  upstreamModelId: string;
}>;

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
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}
