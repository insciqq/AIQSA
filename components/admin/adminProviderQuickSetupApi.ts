import { ADMIN_PROVIDER_SETUP_STREAM_TYPE, type AdminProviderSetupProgress } from "@/lib/contracts/adminProviderSetupProgress";
import { adminProviderSetupFailureCode, readAdminProviderSetupResponse } from "./adminProviderSetupStream";
import { isAdminProviderCheckRun } from "./adminProvidersApi";
import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupCandidate,
  type AdminProviderQuickSetupModelDisplay,
  type AdminProviderQuickSetupProviderId,
  type AdminProviderQuickSetupProviderSnapshot,
  type AdminProviderQuickSetupReadyResult,
  type AdminProviderQuickSetupRequest,
  type AdminProviderQuickSetupResult,
  type AdminProviderQuickSetupSelectionRequiredResult,
  type AdminProviderQuickSetupSnapshot
} from "@/lib/contracts/adminProviderQuickSetup";

export type AdminProviderQuickSetupId = AdminProviderQuickSetupProviderId;
export type AdminProviderQuickSetupModel = AdminProviderQuickSetupModelDisplay;
export type AdminProviderQuickSetupChoice = AdminProviderQuickSetupCandidate;
export type AdminProviderQuickSetupProvider = AdminProviderQuickSetupProviderSnapshot;
export type AdminProviderQuickSetupSelectionResult =
  AdminProviderQuickSetupSelectionRequiredResult;
export type AdminProviderQuickSetupSubmit = AdminProviderQuickSetupRequest;
export type {
  AdminProviderQuickSetupReadyResult,
  AdminProviderQuickSetupResult,
  AdminProviderQuickSetupSnapshot
};

export type AdminProviderQuickSetupClientError = Readonly<{
  code: string;
}>;

export type AdminProviderQuickSetupClientResult<T> =
  | Readonly<{ data: T; ok: true }>
  | Readonly<{ error: AdminProviderQuickSetupClientError; ok: false }>;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const providerIds = new Set<AdminProviderQuickSetupId>(
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS
);


const forbiddenResponseKeys = new Set([
  "apiKey",
  "apiRoot",
  "body",
  "catalog",
  "ciphertext",
  "connections",
  "credentialId",
  "credentialVersionId",
  "draftSecretEnvelope",
  "draftVersion",
  "evidence",
  "fingerprint",
  "groupId",
  "groupIds",
  "groups",
  "headers",
  "password",
  "promptPresets",
  "providerModelId",
  "rawBody",
  "resourceIds",
  "runProfiles",
  "searchStrategies",
  "secret",
  "secretEnvelope",
  "versionId"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => key === actual[index]);
}

function containsForbiddenMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenMaterial);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    forbiddenResponseKeys.has(key) || containsForbiddenMaterial(entry)
  );
}

function safeText(value: unknown, maxLength = 240): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function providerId(value: unknown): value is AdminProviderQuickSetupId {
  return typeof value === "string" && providerIds.has(value as AdminProviderQuickSetupId);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function model(value: unknown): value is AdminProviderQuickSetupModel {
  return record(value) && exactKeys(value, ["displayName"]) && safeText(value.displayName);
}

function searchReceipt(
  value: unknown
): value is AdminProviderQuickSetupReadyResult["search"] {
  return value === null || (
    record(value) && exactKeys(value, ["displayName", "status"]) &&
    safeText(value.displayName, 160) &&
    (value.status === "needs_attention" || value.status === "ready")
  );
}

function models(value: unknown): value is AdminProviderQuickSetupModel[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(model) &&
    new Set(value.map((entry) => (entry as AdminProviderQuickSetupModel).displayName)).size === value.length;
}

function provider(value: unknown): AdminProviderQuickSetupProvider | null {
  if (!record(value) || !exactKeys(value, [
    "candidateModels",
    "provider",
    "providerDisplayName",
    "stateToken"
  ]) || !providerId(value.provider) || !safeText(value.providerDisplayName, 80) ||
    !models(value.candidateModels) ||
    !safeText(value.stateToken, 512)) {
    return null;
  }
  return {
    candidateModels: value.candidateModels,
    provider: value.provider,
    providerDisplayName: value.providerDisplayName,
    stateToken: value.stateToken
  };
}

function snapshot(value: unknown): AdminProviderQuickSetupSnapshot | null {
  if (!record(value) || containsForbiddenMaterial(value) ||
    !exactKeys(value, ["providers"]) ||
    !Array.isArray(value.providers) ||
    value.providers.length !== ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.length) {
    return null;
  }
  const providers = value.providers.map(provider);
  if (providers.some((entry) => entry === null)) return null;
  const ids = providers.map((entry) => entry!.provider);
  if (new Set(ids).size !== providers.length ||
    !ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.every(
      (id) => ids.includes(id as AdminProviderQuickSetupId)
    )) {
    return null;
  }
  return {
    providers: providers as AdminProviderQuickSetupProvider[]
  };
}

function choice(value: unknown): value is AdminProviderQuickSetupChoice {
  return record(value) && exactKeys(value, ["candidateId", "displayName"]) &&
    safeText(value.candidateId, 256) && safeText(value.displayName);
}

function result(value: unknown): AdminProviderQuickSetupResult | null {
  if (!record(value) || typeof value.outcome !== "string") return null;
  const { checkRun, ...receipt } = value;
  if (containsForbiddenMaterial(receipt) || checkRun !== undefined && (!isAdminProviderCheckRun(checkRun) ||
    !checkRun.credentialId || checkRun.state === "running" ||
    (value.outcome === "cancelled") !== (checkRun.state === "cancelled") || value.outcome === "ready" && (checkRun.state !== "completed" ||
      checkRun.done !== checkRun.total || checkRun.failed.length > 0 || Boolean(checkRun.skipped?.length) ||
      checkRun.setup?.state === "partial" || checkRun.setup?.state === "running" ||
      checkRun.results?.some((entry) => entry.state !== "saved")))) return null;
  if (["ready", "partial", "cancelled"].includes(value.outcome) &&
    (value.outcome === "ready" || checkRun !== undefined) && exactKeys(value, [
    "checkedAt",
    "connectionId",
    "defaultCredentialChanged",
    "defaultChanged",
    "model",
    "models",
    "outcome",
    "provider",
    "providerDisplayName",
    ...(value.checkRun === undefined ? [] : ["checkRun"]),
    ...(value.search === undefined ? [] : ["search"])
  ]) && timestamp(value.checkedAt) && safeText(value.connectionId, 128) &&
    typeof value.defaultCredentialChanged === "boolean" &&
    typeof value.defaultChanged === "boolean" &&
    model(value.model) && models(value.models) &&
    providerId(value.provider) && safeText(value.providerDisplayName, 80) &&
    searchReceipt(value.search ?? null)) {
    return value as AdminProviderQuickSetupReadyResult;
  }
  if (value.outcome === "selection_required" && exactKeys(value, [
    "candidates",
    "checkedAt",
    "expectedState",
    "outcome",
    "policyVersion",
    "provider",
    "providerDisplayName"
  ]) && providerId(value.provider) && safeText(value.providerDisplayName, 80) &&
    timestamp(value.checkedAt) && safeText(value.expectedState, 512) &&
    Number.isSafeInteger(value.policyVersion) && Number(value.policyVersion) > 0 &&
    Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.length <= 16 &&
    value.candidates.every(choice) &&
    new Set(value.candidates.map((entry) => entry.candidateId)).size === value.candidates.length) {
    return value as AdminProviderQuickSetupSelectionResult;
  }
  return null;
}

function errorCode(value: unknown, fallback: string): string {
  return record(value) && exactKeys(value, ["error"]) && safeText(value.error, 128)
    ? value.error
    : fallback;
}

async function request<T>(
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher,
  onProgress?: (value: AdminProviderSetupProgress) => void
): Promise<AdminProviderQuickSetupClientResult<T>> {
  try {
    const response = await fetcher("/api/admin/providers/quick-setup", {
      credentials: "same-origin",
      ...init
    });
    const { ok, value } = await readAdminProviderSetupResponse(response, onProgress);
    if (!ok) {
      if (containsForbiddenMaterial(value)) return { error: { code: "provider_quick_setup_response_invalid" }, ok: false };
      return { error: { code: errorCode(value, "provider_admin_action_failed") }, ok: false };
    }
    const data = decode(value);
    return data
      ? { data, ok: true }
      : { error: { code: "provider_quick_setup_response_invalid" }, ok: false };
  } catch (error) {
    return { error: { code: adminProviderSetupFailureCode(error, init.signal) }, ok: false };
  }
}

export function getAdminProviderQuickSetup(
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
) {
  return request({ method: "GET", signal }, snapshot, fetcher);
}

export function submitAdminProviderQuickSetup(
  body: AdminProviderQuickSetupSubmit,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  onProgress?: (value: AdminProviderSetupProgress) => void
) {
  return request({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(onProgress ? { accept: ADMIN_PROVIDER_SETUP_STREAM_TYPE } : {}) },
    method: "POST",
    signal
  }, result, fetcher, onProgress);
}

export function adminProviderQuickSetupErrorMessage(
  error: AdminProviderQuickSetupClientError
): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage providers.",
    request_aborted: "Checking stopped. Saved results are kept.",
    provider_setup_interrupted: "The setup response ended before completion. Review saved results before continuing.",
    provider_setup_timeout: "The setup response stopped arriving. Review saved results before continuing.",
    provider_setup_response_invalid: "The setup response was malformed. Review saved results before continuing.",
    provider_setup_response_too_large: "The setup response exceeded its size limit. Review saved results before continuing.",
    network_error: "Could not reach the provider setup API. Try again.",
    provider_admin_action_failed: "The provider setup could not be completed. Review its saved results before continuing.",
    provider_configuration_invalid: "Review the name, endpoint and timeout, then try again.",
    provider_credential_test_failed: "The provider rejected the key or its account catalog could not be reached.",
    provider_draft_stale: "Providers changed in another window. Close this sheet and try again.",
    provider_quick_setup_advanced_required: "This provider's connection was changed by hand, so it cannot be set up here. Add the key on its provider page instead.",
    provider_quick_setup_name_taken: "Another provider already has this name. Choose a different one.",
    provider_quick_setup_response_invalid: "The provider setup API returned an unexpected response. Close this sheet and try again.",
    provider_quick_setup_selection_invalid: "That model choice is no longer available. Test the key again.",
    provider_quick_setup_unsupported_catalog: "This key has no access to a model AIQSA can set up for this provider.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  return messages[error.code] ?? messages.provider_admin_action_failed!;
}
