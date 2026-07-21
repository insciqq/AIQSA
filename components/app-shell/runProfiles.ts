import type { Catalog, CatalogModel } from "@/components/app-shell/types";

export type RunProfileId = "fast" | "balanced" | "deep";

type RunProfileDefinition = {
  configurationLabel: string;
  description: string;
  id: RunProfileId;
  label: string;
  modelDisplayName: string;
  modelId: string;
  provider: string;
  reasoningEffort: string;
  reasoningMode: string;
};

export const RUN_PROFILES = [
  {
    configurationLabel: "GPT-5.6 Luna · Standard · Medium",
    description: "Simple, well-defined questions",
    id: "fast",
    label: "Fast",
    modelDisplayName: "GPT-5.6 Luna",
    modelId: "gpt-5.6-luna",
    provider: "openai",
    reasoningEffort: "medium",
    reasoningMode: "standard"
  },
  {
    configurationLabel: "GPT-5.6 Terra · Standard · Medium",
    description: "Most everyday questions",
    id: "balanced",
    label: "Balanced",
    modelDisplayName: "GPT-5.6 Terra",
    modelId: "gpt-5.6-terra",
    provider: "openai",
    reasoningEffort: "medium",
    reasoningMode: "standard"
  },
  {
    configurationLabel: "GPT-5.6 Sol · Pro · Max",
    description: "Difficult or open-ended questions",
    id: "deep",
    label: "Deep",
    modelDisplayName: "GPT-5.6 Sol",
    modelId: "gpt-5.6-sol",
    provider: "openai",
    reasoningEffort: "max",
    reasoningMode: "pro"
  }
] as const satisfies readonly RunProfileDefinition[];

export type ResolvedRunProfile = (typeof RUN_PROFILES)[number] & {
  available: boolean;
  model: CatalogModel | null;
  unavailableReason: string | null;
};

type ActiveRunProfileTuple = {
  modelId: string;
  provider: string;
  reasoningEffort: string;
  reasoningMode: string;
};

function readableControlValue(value: string): string {
  if (value === "max") {
    return "Maximum";
  }

  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function unavailableReason(
  profile: (typeof RUN_PROFILES)[number],
  model: CatalogModel | undefined
): string | null {
  if (!model) {
    return `${profile.modelDisplayName} is not available with your model access.`;
  }

  const effortControls = model.parameterControls.reasoningEffort;
  if (
    !model.capabilities.reasoning ||
    !effortControls.supported ||
    !effortControls.options.includes(profile.reasoningEffort)
  ) {
    return `${profile.modelDisplayName} does not support ${readableControlValue(profile.reasoningEffort)} reasoning effort.`;
  }

  const modeControls = model.parameterControls.reasoningMode;
  if (
    !modeControls?.supported ||
    !modeControls.options.includes(profile.reasoningMode)
  ) {
    return `${profile.modelDisplayName} does not support ${readableControlValue(profile.reasoningMode)} reasoning mode.`;
  }

  return null;
}

export function resolveRunProfiles(catalog: Catalog | null): ResolvedRunProfile[] {
  return RUN_PROFILES.map((profile) => {
    const model =
      catalog?.models.find(
        (candidate) =>
          candidate.provider === profile.provider && candidate.modelId === profile.modelId
      ) ?? null;
    const reason = catalog
      ? unavailableReason(profile, model ?? undefined)
      : "Run profiles are unavailable until the model catalog loads.";

    return {
      ...profile,
      available: reason === null,
      model,
      unavailableReason: reason
    };
  });
}

export function findActiveRunProfile(
  profiles: readonly ResolvedRunProfile[],
  current: ActiveRunProfileTuple
): ResolvedRunProfile | null {
  return (
    profiles.find(
      (profile) =>
        profile.available &&
        profile.provider === current.provider &&
        profile.modelId === current.modelId &&
        profile.reasoningEffort === current.reasoningEffort &&
        profile.reasoningMode === current.reasoningMode
    ) ?? null
  );
}
