/**
 * Canonical model identity of usage rows. Run-level rows store the run's
 * connection id and ProviderModel id; ancillary rows store the provider family,
 * the upstream model id and usually `providerModelId`; chat-summary rows store
 * the family and the ProviderModel id in `modelId`. Rows that name the same
 * catalog model group together under one label; anything else stays raw.
 */

export type UsageCatalogModel = Readonly<{
  connectionDisplayName: string;
  connectionId: string;
  displayName: string;
  family: string;
  id: string;
  /** The row's `modelId` and the active configuration's `upstreamModelId`. */
  upstreamModelIds: readonly string[];
}>;

export type UsageRawModelKey = Readonly<{ modelId: string; provider: string; providerModelId: string | null }>;

export type ResolvedUsageModel = Readonly<{
  /** Grouping key, also used inside SQL. */
  key: string;
  /** Contract `label`: "<connection> / <model>" or the raw model id. */
  label: string;
  modelId: string;
  /** CSV `model` column: the catalog display name or the raw model id. */
  modelLabel: string;
  provider: string;
  /** CSV `provider` column: the connection display name or the raw provider. */
  providerLabel: string;
}>;

const SEPARATOR = "\u001f";
export const MAX_USAGE_LABEL_LENGTH = 512;
export const MAX_USAGE_MODEL_ID_LENGTH = 512;
export const MAX_USAGE_PROVIDER_LENGTH = 256;

/** Non-empty and within the contract bound. */
export function boundedUsageText(value: string | null | undefined, maxLength: number, fallback: string): string {
  const text = value?.trim() ? value : fallback;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** The SQL fallback key for a row whose raw identity was not resolved (built identically in SQL). */
export function rawUsageModelKey(provider: string, modelId: string): string {
  return `raw${SEPARATOR}${provider}${SEPARATOR}${modelId}`;
}

function rawModel(provider: string, modelId: string): ResolvedUsageModel {
  const boundedModel = boundedUsageText(modelId, MAX_USAGE_MODEL_ID_LENGTH, "unknown");
  const boundedProvider = boundedUsageText(provider, MAX_USAGE_PROVIDER_LENGTH, "unknown");
  return {
    key: rawUsageModelKey(provider, modelId),
    label: boundedUsageText(modelId, MAX_USAGE_LABEL_LENGTH, "unknown"),
    modelId: boundedModel,
    modelLabel: boundedModel,
    provider: boundedProvider,
    providerLabel: boundedProvider
  };
}

/** Parses a key that only SQL produced (a row written after the keys were resolved). */
export function resolvedFromUsageModelKey(key: string): ResolvedUsageModel {
  const [prefix, provider = "", ...modelId] = key.split(SEPARATOR);
  return prefix === "raw" ? rawModel(provider, modelId.join(SEPARATOR)) : rawModel("unknown", key);
}

function catalogEntry(model: UsageCatalogModel): ResolvedUsageModel {
  const providerLabel = boundedUsageText(model.connectionDisplayName, MAX_USAGE_LABEL_LENGTH, model.connectionId);
  const modelLabel = boundedUsageText(model.displayName, MAX_USAGE_LABEL_LENGTH, model.id);
  return {
    key: `model${SEPARATOR}${model.id}`,
    label: boundedUsageText(`${providerLabel} / ${modelLabel}`, MAX_USAGE_LABEL_LENGTH, model.id),
    modelId: boundedUsageText(model.id, MAX_USAGE_MODEL_ID_LENGTH, "unknown"),
    modelLabel,
    provider: boundedUsageText(model.connectionId, MAX_USAGE_PROVIDER_LENGTH, "unknown"),
    providerLabel
  };
}

/**
 * Resolution order: exact `providerModelId`; then the ProviderModel whose id is
 * `modelId` under that connection or family; then the single model whose
 * upstream id is `modelId` under that family or connection; else raw
 * `(provider, modelId)`. Ambiguous upstream matches stay raw.
 */
export function createUsageModelResolver(catalog: readonly UsageCatalogModel[]): (key: UsageRawModelKey) => ResolvedUsageModel {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const owns = (model: UsageCatalogModel, provider: string) => model.connectionId === provider || model.family === provider;
  return (key) => {
    const exact = key.providerModelId ? byId.get(key.providerModelId) : undefined;
    if (exact) return catalogEntry(exact);
    const byModelId = byId.get(key.modelId);
    if (byModelId && owns(byModelId, key.provider)) return catalogEntry(byModelId);
    const upstream = catalog.filter((model) => owns(model, key.provider) && model.upstreamModelIds.includes(key.modelId));
    return upstream.length === 1 ? catalogEntry(upstream[0]!) : rawModel(key.provider, key.modelId);
  };
}
