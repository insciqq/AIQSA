import {
  RUN_PROFILE_IDS,
  type AdminRunProfile,
  type AdminRunProfileCatalog,
  type AdminRunProfileModel,
  type RunProfileId
} from "@/lib/contracts/runProfiles";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminRunProfileClientResult =
  | { data: AdminRunProfileCatalog; ok: true }
  | { error: string; ok: false };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((entry) => boundedString(entry, 64));
  return values.every((entry): entry is string => entry !== null) ? values : null;
}

function profile(value: unknown): AdminRunProfile | null {
  if (!record(value)) return null;
  const id = RUN_PROFILE_IDS.includes(value.id as RunProfileId)
    ? value.id as RunProfileId
    : null;
  const label = boundedString(value.label, 64);
  const description = boundedString(value.description, 240);
  const providerModelId = value.providerModelId === null
    ? null
    : boundedString(value.providerModelId, 256);
  const reasoningEffort = boundedString(value.reasoningEffort, 64);
  const reasoningMode = boundedString(value.reasoningMode, 64);
  const updatedAt = boundedString(value.updatedAt, 64);
  if (
    !id ||
    !label ||
    !description ||
    typeof value.enabled !== "boolean" ||
    providerModelId === null !== (value.providerModelId === null) ||
    value.enabled !== (providerModelId !== null) ||
    !reasoningEffort ||
    !reasoningMode ||
    !updatedAt ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    return null;
  }
  return {
    description,
    enabled: value.enabled,
    id,
    label,
    providerModelId,
    reasoningEffort,
    reasoningMode,
    updatedAt,
    version: Number(value.version)
  };
}

function model(value: unknown): AdminRunProfileModel | null {
  if (!record(value)) return null;
  const defaultReasoningEffort = boundedString(value.defaultReasoningEffort, 64);
  const defaultReasoningMode = boundedString(value.defaultReasoningMode, 64);
  const displayName = boundedString(value.displayName, 256);
  const id = boundedString(value.id, 256);
  const providerDisplayName = boundedString(value.providerDisplayName, 256);
  const reasoningEfforts = stringArray(value.reasoningEfforts);
  const reasoningModes = stringArray(value.reasoningModes);
  if (
    typeof value.connectionEnabled !== "boolean" ||
    !defaultReasoningEffort ||
    !defaultReasoningMode ||
    !displayName ||
    !id ||
    typeof value.modelEnabled !== "boolean" ||
    !providerDisplayName ||
    !reasoningEfforts ||
    !reasoningModes ||
    typeof value.selectable !== "boolean"
  ) {
    return null;
  }
  return {
    connectionEnabled: value.connectionEnabled,
    defaultReasoningEffort,
    defaultReasoningMode,
    displayName,
    id,
    modelEnabled: value.modelEnabled,
    providerDisplayName,
    reasoningEfforts,
    reasoningModes,
    selectable: value.selectable
  };
}

function catalog(value: unknown): AdminRunProfileCatalog | null {
  if (
    !record(value) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length !== RUN_PROFILE_IDS.length ||
    !Array.isArray(value.models) ||
    value.models.length > 2_000
  ) {
    return null;
  }
  const profiles = value.profiles.map(profile);
  const models = value.models.map(model);
  if (
    profiles.some((entry) => entry === null) ||
    models.some((entry) => entry === null)
  ) {
    return null;
  }
  const profileIds = new Set(profiles.map((entry) => entry!.id));
  if (RUN_PROFILE_IDS.some((id) => !profileIds.has(id)) || profileIds.size !== RUN_PROFILE_IDS.length) {
    return null;
  }
  return {
    models: models as AdminRunProfileModel[],
    profiles: RUN_PROFILE_IDS.map(
      (id) => profiles.find((entry) => entry?.id === id)!
    )
  };
}

async function request(
  init: RequestInit,
  fetcher: Fetcher
): Promise<AdminRunProfileClientResult> {
  try {
    const response = await fetcher("/api/admin/run-profiles", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: record(value) && typeof value.error === "string"
          ? value.error
          : "run_profile_admin_action_failed",
        ok: false
      };
    }
    const decoded = catalog(value);
    return decoded
      ? { data: decoded, ok: true }
      : { error: "run_profile_admin_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminRunProfiles(fetcher: Fetcher = fetch) {
  return request({ method: "GET" }, fetcher);
}

export function updateAdminRunProfiles(profiles: unknown, fetcher: Fetcher = fetch) {
  return request({
    body: JSON.stringify({ profiles }),
    headers: { "content-type": "application/json" },
    method: "PUT"
  }, fetcher);
}

export function adminRunProfileErrorMessage(code: string): string {
  if (code === "run_profile_stale") {
    return "Run profiles changed elsewhere. Refresh and apply your changes again.";
  }
  if (code === "run_profile_target_invalid") {
    return "Choose an active model and reasoning values that it supports.";
  }
  if (code === "forbidden" || code === "unauthorized") {
    return "Administrator access is required to manage run profiles.";
  }
  if (code === "network_error") {
    return "Run profiles could not be reached. Check the connection and retry.";
  }
  return "Run profiles could not be saved. Review the configuration and retry.";
}
