import type {
  AdminProviderConnectionConfiguration,
  AdminProviderModelConfiguration
} from "../../../contracts/adminProviders";
import {
  effectiveProviderResponseTimeoutMs,
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  providerResponseTimeoutMsFromSeconds,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAdminProviderConnectionConfiguration(
  value: unknown
): ProviderConnectionConfiguration {
  const record = isRecord(value) ? value : {};
  return normalizeProviderConnectionConfiguration({
    ...record,
    responseTimeoutMs: providerResponseTimeoutMsFromSeconds(
      record.responseTimeoutSeconds,
      null
    )
  });
}

export function normalizeAdminProviderModelConfiguration(
  value: unknown
): ProviderModelConfiguration {
  const record = isRecord(value) ? value : {};
  const responseTimeoutMs = providerResponseTimeoutMsFromSeconds(
    record.responseTimeoutSeconds,
    null
  );
  return normalizeProviderModelConfiguration({
    ...record,
    responseTimeoutMs
  });
}

export function adminProviderConnectionConfiguration(
  value: unknown
): AdminProviderConnectionConfiguration {
  const configuration = normalizeProviderConnectionConfiguration(value);
  return {
    allowPrivateNetwork: configuration.allowPrivateNetwork,
    apiRoot: configuration.apiRoot,
    authenticationMode: configuration.authenticationMode,
    responseTimeoutSeconds: effectiveProviderResponseTimeoutMs(configuration) / 1_000
  };
}

export function adminProviderModelConfiguration(
  value: unknown
): AdminProviderModelConfiguration {
  const configuration = normalizeProviderModelConfiguration(value);
  return {
    adapterKind: configuration.adapterKind,
    answerSelectable: configuration.answerSelectable,
    capabilities: configuration.capabilities,
    defaultParams: configuration.defaultParams,
    ...(configuration.embedding ? { embedding: configuration.embedding } : {}),
    modelClass: configuration.modelClass,
    ...(configuration.openRouterRouting
      ? { openRouterRouting: configuration.openRouterRouting }
      : {}),
    ...(configuration.reasoningRequestMapping
      ? { reasoningRequestMapping: configuration.reasoningRequestMapping }
      : {}),
    ...(configuration.responseTimeoutMs === undefined
      ? {}
      : { responseTimeoutSeconds: configuration.responseTimeoutMs / 1_000 }),
    upstreamModelId: configuration.upstreamModelId
  };
}
