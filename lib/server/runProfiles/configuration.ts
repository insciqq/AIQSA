import {
  resolveProviderModelParameterControls,
  type CatalogAdapterKind
} from "../../domain/catalog";
import type { ModelParameterControls } from "../../contracts/catalog";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration
} from "../providers/providerConfiguration";

export type RunProfileModelRecord = Readonly<{
  activeConfig: unknown;
  activeVersion: number;
  activatedAt: Date | null;
  connection: {
    activeConfig: unknown;
    activeVersion: number;
    activatedAt: Date | null;
    displayName: string;
    enabled: boolean;
    family: string;
  };
  displayName: string;
  enabled: boolean;
  id: string;
}>;

export type ResolvedRunProfileModel = Readonly<{
  controls: ModelParameterControls;
  selectable: true;
}>;

export function resolveRunProfileModel(
  model: RunProfileModelRecord
): ResolvedRunProfileModel | null {
  if (
    !model.enabled ||
    model.activeVersion <= 0 ||
    !model.activatedAt ||
    !model.connection.enabled ||
    model.connection.activeVersion <= 0 ||
    !model.connection.activatedAt ||
    model.connection.family === "fake"
  ) {
    return null;
  }

  try {
    normalizeProviderConnectionConfiguration(model.connection.activeConfig);
    const configuration = normalizeProviderModelConfiguration(model.activeConfig);
    if (!configuration.answerSelectable) return null;
    const controls = resolveProviderModelParameterControls({
      adapterKind: configuration.adapterKind as CatalogAdapterKind,
      defaultParams: configuration.defaultParams,
      providerFamily: model.connection.family,
      supportsReasoning: configuration.capabilities.reasoning,
      supportsStreaming: configuration.capabilities.streaming ?? false,
      upstreamModelId: configuration.upstreamModelId
    });
    return { controls, selectable: true };
  } catch {
    return null;
  }
}

export function supportsRunProfileReasoning(input: {
  controls: ModelParameterControls;
  reasoningEffort: string;
  reasoningMode: string;
}): boolean {
  const modeOptions = input.controls.reasoningMode?.options ?? ["standard"];
  return input.controls.reasoningEffort.options.includes(input.reasoningEffort) &&
    modeOptions.includes(input.reasoningMode);
}
