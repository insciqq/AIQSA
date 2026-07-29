import type {
  AdminCompatibleDiscoveredModel,
  AdminProviderModelCapabilities
} from "@/lib/contracts/adminProviders";

export type AdminProviderReasoningChoice =
  | "automatic"
  | "disabled"
  | "openai_gpt_5_6_sol";

type ReasoningCapabilities = Pick<
  AdminProviderModelCapabilities,
  | "reasoning"
  | "defaultReasoningEffort"
  | "defaultReasoningMode"
  | "reasoningEfforts"
  | "reasoningModes"
>;

const reasoningKeys = [
  "defaultReasoningEffort",
  "defaultReasoningMode",
  "reasoningEfforts",
  "reasoningModes"
] as const;

export function openAiGpt56SolReasoning(): ReasoningCapabilities {
  return {
    defaultReasoningEffort: "medium",
    defaultReasoningMode: "standard",
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    reasoningModes: ["standard", "pro"]
  };
}

export function applyReasoningCapabilities(
  current: AdminProviderModelCapabilities,
  reasoning: ReasoningCapabilities
): AdminProviderModelCapabilities {
  const next = { ...current };
  for (const key of reasoningKeys) delete next[key];
  return { ...next, ...reasoning };
}

export function discoveredReasoning(
  model: AdminCompatibleDiscoveredModel | undefined
): ReasoningCapabilities | null {
  const capabilities = model?.capabilities;
  if (!capabilities || capabilities.reasoning === undefined) return null;
  if (!capabilities.reasoning) return { reasoning: false };
  const efforts = capabilities.reasoningEfforts;
  if (!efforts?.length) return null;
  const modes = capabilities.reasoningModes;
  return {
    defaultReasoningEffort: capabilities.defaultReasoningEffort &&
      efforts.includes(capabilities.defaultReasoningEffort)
      ? capabilities.defaultReasoningEffort
      : efforts[0]!,
    reasoning: true,
    reasoningEfforts: [...efforts],
    ...(modes?.length ? {
      defaultReasoningMode: capabilities.defaultReasoningMode &&
        modes.includes(capabilities.defaultReasoningMode)
        ? capabilities.defaultReasoningMode
        : modes[0]!,
      reasoningModes: [...modes]
    } : {})
  };
}

function intersection(values: readonly string[][]): string[] {
  const [first, ...rest] = values;
  return first?.filter((value) => rest.every((options) => options.includes(value))) ?? [];
}

export function discoveredReasoningForModels(
  models: readonly AdminCompatibleDiscoveredModel[]
): ReasoningCapabilities | null {
  if (!models.length) return null;
  const reported = models.map((model) => discoveredReasoning(model));
  if (reported.some((value) => value === null)) return null;
  const controls = reported as ReasoningCapabilities[];
  if (controls.some(({ reasoning }) => !reasoning)) return { reasoning: false };
  const efforts = intersection(controls.map(({ reasoningEfforts }) => reasoningEfforts ?? []));
  if (!efforts.length) return { reasoning: false };
  const preferredEffort = controls[0]?.defaultReasoningEffort;
  const defaultReasoningEffort = preferredEffort && efforts.includes(preferredEffort)
    ? preferredEffort
    : efforts.includes("medium") ? "medium" : efforts[0]!;
  const allHaveModes = controls.every(({ reasoningModes }) => Boolean(reasoningModes?.length));
  const modes = allHaveModes
    ? intersection(controls.map(({ reasoningModes }) => reasoningModes ?? []))
    : [];
  const preferredMode = controls[0]?.defaultReasoningMode;
  return {
    defaultReasoningEffort,
    reasoning: true,
    reasoningEfforts: efforts,
    ...(modes.length ? {
      defaultReasoningMode: preferredMode && modes.includes(preferredMode)
        ? preferredMode
        : modes.includes("standard") ? "standard" : modes[0]!,
      reasoningModes: modes
    } : {})
  };
}

export function reasoningForChoice(
  choice: AdminProviderReasoningChoice,
  models: readonly AdminCompatibleDiscoveredModel[]
): ReasoningCapabilities {
  if (choice === "disabled") return { reasoning: false };
  if (choice === "openai_gpt_5_6_sol") return openAiGpt56SolReasoning();
  return discoveredReasoningForModels(models) ?? openAiGpt56SolReasoning();
}

export function reasoningCapabilitiesEqual(
  capabilities: AdminProviderModelCapabilities,
  expected: ReasoningCapabilities
): boolean {
  const list = (value: readonly string[] | undefined) => value?.join("\u0000") ?? "";
  return capabilities.reasoning === expected.reasoning &&
    capabilities.defaultReasoningEffort === expected.defaultReasoningEffort &&
    capabilities.defaultReasoningMode === expected.defaultReasoningMode &&
    list(capabilities.reasoningEfforts) === list(expected.reasoningEfforts) &&
    list(capabilities.reasoningModes) === list(expected.reasoningModes);
}

export function reasoningCapabilitiesSummary(reasoning: ReasoningCapabilities): string {
  if (!reasoning.reasoning) return "Reasoning disabled.";
  const efforts = reasoning.reasoningEfforts?.join(", ") ?? "provider defaults";
  const modes = reasoning.reasoningModes?.length
    ? ` Modes: ${reasoning.reasoningModes.join(", ")}.`
    : "";
  return `Effort: ${efforts}; default ${reasoning.defaultReasoningEffort ?? "provider default"}.${modes}`;
}
