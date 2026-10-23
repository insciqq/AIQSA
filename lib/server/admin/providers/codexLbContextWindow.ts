import type { AdminCompatibleDiscoveredModel } from "../../../contracts/adminProviders";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";

/** Codex LB template window, used only when the gateway listing publishes none for the model. */
export const CODEX_LB_TEMPLATE_CONTEXT_WINDOW = 272_000;

/** The window the exact connection's catalog publishes for one model, if any. */
export function listedContextWindow(
  models: readonly AdminCompatibleDiscoveredModel[] | undefined,
  upstreamModelId: string
): number | undefined {
  return models?.find(({ id }) => id === upstreamModelId)?.capabilities.contextWindow;
}

/** True while an answer model carries no window or the template default, which the listing may replace. */
export function contextWindowRefreshable(configuration: ProviderModelConfiguration): boolean {
  const current = configuration.capabilities.contextWindow;
  return configuration.modelClass === "answer" && (current === undefined || current === CODEX_LB_TEMPLATE_CONTEXT_WINDOW);
}

/**
 * Fills an answer model's missing or template-default window from the
 * gateway listing. Any other stored window is an administrator's choice and is
 * kept, whether it is above or below the listed one (production Codex LB rows
 * were raised by hand on 2026-10-23). No listed window keeps the stored value.
 */
export function withListedContextWindow(
  configuration: ProviderModelConfiguration,
  listed: number | undefined
): ProviderModelConfiguration {
  if (listed === undefined || configuration.capabilities.contextWindow === listed ||
    !contextWindowRefreshable(configuration)) return configuration;
  return { ...configuration, capabilities: { ...configuration.capabilities, contextWindow: listed } };
}
