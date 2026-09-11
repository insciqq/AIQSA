import type { AdminProviderCatalogModel, AdminProviderCatalogUpdates, AdminProviderConnection, AdminProviderModel } from "../../../contracts/adminProviders";
import { providerSetupModels, type SetupModel } from "./setupModels";

export function catalogModelPresent(model: AdminProviderModel, candidate: SetupModel): boolean {
  return model.id === candidate.modelId || [model.draftConfig, model.activeConfig].some((configuration) => configuration !== null &&
    configuration.modelClass === candidate.configuration.modelClass &&
    configuration.upstreamModelId === candidate.configuration.upstreamModelId);
}

export function catalogModelProjection(candidate: SetupModel): AdminProviderCatalogModel {
  return { id: candidate.modelId, displayName: candidate.displayName,
    modelClass: candidate.configuration.modelClass, upstreamModelId: candidate.configuration.upstreamModelId };
}

/** Pure derivation against the active endpoint, including draft/disabled/manual identities. */
export function providerCatalogUpdates(
  connection: Pick<AdminProviderConnection, "activeConfig" | "family" | "models">,
  skippedIds: readonly string[]
): AdminProviderCatalogUpdates {
  if (!connection.activeConfig) return { available: [], skipped: [] };
  const skipped = new Set(skippedIds);
  const missing = providerSetupModels(connection.family, connection.activeConfig.apiRoot)
    .filter((candidate) => !connection.models.some((model) => catalogModelPresent(model, candidate)));
  return {
    available: missing.filter((candidate) => !skipped.has(candidate.modelId)).map(catalogModelProjection),
    skipped: missing.filter((candidate) => skipped.has(candidate.modelId)).map(catalogModelProjection)
  };
}
