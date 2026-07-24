import { defaultProviderModels, type CatalogAdapterKind } from "../../domain/catalog";
import type { ProviderModelCapabilities } from "./types";

type ProviderModelCapabilityResolution = Readonly<{
  adapterKind: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  legacyContextWindow?: number | null;
  providerFamily: string;
  upstreamModelId: string;
}>;

function usableLegacyContextWindow(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 1
    ? value
    : undefined;
}

/**
 * Resolves context metadata without ever exposing the provider-control-plane
 * compatibility sentinel (`1`) as a real model limit.
 */
export function resolveProviderModelCapabilities(
  input: ProviderModelCapabilityResolution
): ProviderModelCapabilities {
  const template = defaultProviderModels.find(
    (model) =>
      model.adapterKind === input.adapterKind &&
      model.providerFamily === input.providerFamily &&
      model.upstreamModelId === input.upstreamModelId
  );
  const contextWindow =
    input.capabilities.contextWindow ??
    usableLegacyContextWindow(input.legacyContextWindow) ??
    template?.contextWindow;

  return {
    ...input.capabilities,
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}
