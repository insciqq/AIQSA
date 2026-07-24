import type { Catalog, CatalogModel } from "@/components/app-shell/types";
import type { CatalogRunProfile, RunProfileId } from "@/lib/contracts/runProfiles";

export type { RunProfileId } from "@/lib/contracts/runProfiles";

export type ResolvedRunProfile = Readonly<{
  available: boolean;
  configurationLabel: string;
  description: string;
  id: RunProfileId;
  label: string;
  model: CatalogModel | null;
  reasoningEffort: string;
  reasoningMode: string;
  unavailableReason: string | null;
}>;

function unavailableReason(profile: CatalogRunProfile): string {
  if (profile.available || profile.unavailableReason === "model_unavailable") {
    return `${profile.label} is not available with your model access.`;
  }
  return `${profile.label} has an invalid administrator configuration.`;
}

export function resolveRunProfiles(catalog: Catalog | null): ResolvedRunProfile[] {
  return (catalog?.runProfiles ?? []).map((profile) => {
    if (!profile.available) {
      return {
        available: false,
        configurationLabel: "Unavailable",
        description: profile.description,
        id: profile.id,
        label: profile.label,
        model: null,
        reasoningEffort: "",
        reasoningMode: "",
        unavailableReason: unavailableReason(profile)
      };
    }
    const model = catalog?.models.find(
      (candidate) =>
        candidate.provider === profile.provider && candidate.modelId === profile.modelId
    ) ?? null;
    if (!model) {
      return {
        available: false,
        configurationLabel: "Unavailable",
        description: profile.description,
        id: profile.id,
        label: profile.label,
        model: null,
        reasoningEffort: "",
        reasoningMode: "",
        unavailableReason: `${profile.label} is not available with your model access.`
      };
    }
    return {
      available: true,
      configurationLabel: profile.configurationLabel,
      description: profile.description,
      id: profile.id,
      label: profile.label,
      model,
      reasoningEffort: profile.reasoningEffort,
      reasoningMode: profile.reasoningMode,
      unavailableReason: null
    };
  });
}

export function findActiveRunProfile(
  profiles: readonly ResolvedRunProfile[],
  current: {
    modelId: string;
    provider: string;
    reasoningEffort: string;
    reasoningMode: string;
  }
): ResolvedRunProfile | null {
  return profiles.find(
    (profile) =>
      profile.available &&
      profile.model !== null &&
      profile.model.provider === current.provider &&
      profile.model.modelId === current.modelId &&
      profile.reasoningEffort === current.reasoningEffort &&
      profile.reasoningMode === current.reasoningMode
  ) ?? null;
}
