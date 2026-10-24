import type { OpenRouterDiscoveredModel } from "../../providers/openRouterDiscovery";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { configuredModelParameterControls } from "../../providers/providerModelCapabilities";

/**
 * Whether the exact connection's OpenRouter listing says the model always
 * reasons. A listing without the model or without a `reasoning.mandatory`
 * boolean stays unknown.
 */
export function listedReasoningMandatory(
  models: readonly Pick<OpenRouterDiscoveredModel, "id" | "reasoningMandatory">[] | undefined,
  upstreamModelId: string
): boolean | undefined {
  return models?.find(({ id }) => id === upstreamModelId)?.reasoningMandatory;
}

/** Only OpenRouter answer models with a reasoning control are affected. */
export function openRouterReasoningListingApplies(configuration: ProviderModelConfiguration): boolean {
  return configuration.adapterKind === "openrouter_chat_completions" &&
    configuration.modelClass === "answer" && configuration.capabilities.reasoning;
}

function reasoningEffortControl(configuration: ProviderModelConfiguration) {
  return configuredModelParameterControls(configuration, "openrouter").reasoningEffort;
}

function withoutSavedEfforts(configuration: ProviderModelConfiguration): ProviderModelConfiguration {
  const capabilities = { ...configuration.capabilities };
  delete capabilities.reasoningEfforts;
  delete capabilities.defaultReasoningEffort;
  return { ...configuration, capabilities };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Off (`none`) is refused with HTTP 400 by a model whose listing says its
 * reasoning is mandatory, so such a model saves the levels it would offer
 * without Off; nothing else about the levels is remapped. The default level
 * is kept unless it was Off, which then moves to `medium` (or the first level).
 *
 * The narrowing follows the listing both ways: when a later listing says
 * reasoning is optional and the saved levels are exactly the narrowed ones,
 * the saved levels are dropped so Off is offered again. Unknown (no listing,
 * no flag) keeps the saved configuration, and so does a reviewed catalog
 * template, whose levels never come from saved capabilities.
 */
export function withListedReasoningRequirement(
  configuration: ProviderModelConfiguration,
  mandatory: boolean | undefined
): ProviderModelConfiguration {
  if (mandatory === undefined || !openRouterReasoningListingApplies(configuration)) return configuration;
  if (mandatory) {
    const control = reasoningEffortControl(configuration);
    if (!control.supported || !control.options.includes("none")) return configuration;
    const reasoningEfforts = control.options.filter((effort) => effort !== "none");
    if (!reasoningEfforts.length) return configuration;
    const defaultReasoningEffort = control.defaultValue !== "none" && reasoningEfforts.includes(control.defaultValue)
      ? control.defaultValue
      : reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0]!;
    const narrowed = { ...configuration,
      capabilities: { ...configuration.capabilities, defaultReasoningEffort, reasoningEfforts } };
    // A reviewed template keeps its own levels; saving unused ones would only confuse.
    return reasoningEffortControl(narrowed).options.includes("none") ? configuration : narrowed;
  }
  const saved = configuration.capabilities.reasoningEfforts;
  if (!saved?.length || saved.includes("none")) return configuration;
  const restored = withoutSavedEfforts(configuration);
  const offered = reasoningEffortControl(restored);
  return offered.supported && offered.options.includes("none") &&
    sameList(offered.options.filter((effort) => effort !== "none"), saved)
    ? restored
    : configuration;
}
