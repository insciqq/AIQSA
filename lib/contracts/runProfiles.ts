export const RUN_PROFILE_IDS = ["fast", "balanced", "deep"] as const;

export type RunProfileId = (typeof RUN_PROFILE_IDS)[number];

export type AdminRunProfile = {
  description: string;
  enabled: boolean;
  id: RunProfileId;
  label: string;
  providerModelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
  updatedAt: string;
  version: number;
};

export type AdminRunProfileModel = {
  connectionEnabled: boolean;
  defaultReasoningEffort: string;
  defaultReasoningMode: string;
  displayName: string;
  id: string;
  modelEnabled: boolean;
  providerDisplayName: string;
  reasoningEfforts: string[];
  reasoningModes: string[];
  selectable: boolean;
};

export type AdminRunProfileCatalog = {
  models: AdminRunProfileModel[];
  profiles: AdminRunProfile[];
};

export type CatalogRunProfileBase = {
  description: string;
  id: RunProfileId;
  label: string;
};

export type CatalogRunProfile = CatalogRunProfileBase & (
  | {
      available: true;
      configurationLabel: string;
      modelId: string;
      provider: string;
      reasoningEffort: string;
      reasoningMode: string;
    }
  | {
      available: false;
      unavailableReason: "configuration_invalid" | "model_unavailable";
    }
);
