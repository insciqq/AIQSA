import type {
  AdminRunProfile,
  AdminRunProfileCatalog,
  AdminRunProfileModel,
  RunProfileId
} from "../../../contracts/runProfiles";
import { RUN_PROFILE_IDS } from "../../../contracts/runProfiles";
import { runProfileMetadata } from "../../../domain/runProfiles";
import { resolveRunProfileModel } from "../../runProfiles/configuration";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import type {
  AdminRunProfileRepository,
  AdminRunProfileState,
  RunProfileWrite
} from "./repositoryContract";

export type AdminRunProfileServiceErrorCode =
  | "run_profile_configuration_invalid"
  | "run_profile_stale"
  | "run_profile_target_invalid";

export class AdminRunProfileServiceError extends Error {
  readonly code: AdminRunProfileServiceErrorCode;

  constructor(code: AdminRunProfileServiceErrorCode) {
    super(code);
    this.code = code;
    this.name = "AdminRunProfileServiceError";
  }
}

function catalog(state: AdminRunProfileState): AdminRunProfileCatalog {
  const profiles = RUN_PROFILE_IDS.map((id): AdminRunProfile => {
    const profile = state.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new Error("run_profile_state_incomplete");
    }
    return {
      description: profile.description,
      enabled: profile.enabled,
      id: profile.id,
      label: runProfileMetadata(profile.id).label,
      providerModelId: profile.providerModelId,
      reasoningEffort: profile.reasoningEffort,
      reasoningMode: profile.reasoningMode,
      updatedAt: profile.updatedAt.toISOString(),
      version: profile.version
    };
  });
  const models = state.models.flatMap((model): AdminRunProfileModel[] => {
    try {
      if (!normalizeProviderModelConfiguration(model.activeConfig).answerSelectable) return [];
    } catch {
      // Preserve existing inactive/malformed rows so an administrator can
      // reconcile a saved profile without losing its deployment identity.
    }
    const resolved = resolveRunProfileModel(model);
    return [{
      connectionEnabled: model.connection.enabled,
      defaultReasoningEffort: resolved?.controls.reasoningEffort.defaultValue ?? "none",
      defaultReasoningMode: resolved?.controls.reasoningMode?.defaultValue ?? "standard",
      displayName: model.displayName,
      id: model.id,
      modelEnabled: model.enabled,
      providerDisplayName: model.connection.displayName,
      reasoningEfforts: resolved?.controls.reasoningEffort.options ?? [],
      reasoningModes: resolved?.controls.reasoningMode?.options ?? ["standard"],
      selectable: Boolean(resolved)
    }];
  });
  return { models, profiles };
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function normalizeWrites(value: unknown): RunProfileWrite[] {
  if (!Array.isArray(value) || value.length !== RUN_PROFILE_IDS.length) {
    throw new AdminRunProfileServiceError("run_profile_configuration_invalid");
  }
  const seen = new Set<RunProfileId>();
  const writes = value.map((entry): RunProfileWrite => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AdminRunProfileServiceError("run_profile_configuration_invalid");
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const description = boundedText(record.description, 240);
    const reasoningEffort = boundedText(record.reasoningEffort, 64);
    const reasoningMode = boundedText(record.reasoningMode, 64);
    const expectedVersion = record.expectedVersion;
    const enabled = record.enabled;
    const providerModelId = record.providerModelId;
    if (
      !RUN_PROFILE_IDS.includes(id as RunProfileId) ||
      seen.has(id as RunProfileId) ||
      !description ||
      !reasoningEffort ||
      !reasoningMode ||
      typeof enabled !== "boolean" ||
      !Number.isSafeInteger(expectedVersion) ||
      Number(expectedVersion) < 1 ||
      (enabled && (typeof providerModelId !== "string" || !providerModelId.trim())) ||
      (!enabled && providerModelId !== null)
    ) {
      throw new AdminRunProfileServiceError("run_profile_configuration_invalid");
    }
    seen.add(id as RunProfileId);
    return {
      description,
      enabled,
      expectedVersion: Number(expectedVersion),
      id: id as RunProfileId,
      providerModelId: enabled ? (providerModelId as string).trim() : null,
      reasoningEffort,
      reasoningMode
    };
  });
  if (RUN_PROFILE_IDS.some((id) => !seen.has(id))) {
    throw new AdminRunProfileServiceError("run_profile_configuration_invalid");
  }
  return writes;
}

export function createAdminRunProfileService(repository: AdminRunProfileRepository) {
  return {
    async getCatalog(): Promise<AdminRunProfileCatalog> {
      return catalog(await repository.loadState());
    },

    async update(input: { profiles: unknown; updatedByUserId: string }): Promise<AdminRunProfileCatalog> {
      const profiles = normalizeWrites(input.profiles);
      const result = await repository.updateAll({ profiles, updatedByUserId: input.updatedByUserId });
      if (result === "stale") {
        throw new AdminRunProfileServiceError("run_profile_stale");
      }
      if (result === "invalid_target") {
        throw new AdminRunProfileServiceError("run_profile_target_invalid");
      }
      return catalog(result);
    }
  };
}

export type AdminRunProfileService = ReturnType<typeof createAdminRunProfileService>;
