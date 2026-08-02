import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupClearRequest,
  type AdminProviderQuickSetupClearResult,
  type AdminProviderQuickSetupCandidate,
  type AdminProviderQuickSetupConnectionSummary,
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
export type AdminProviderQuickSetupConnection = AdminProviderQuickSetupConnectionSummary;
export type AdminProviderQuickSetupProvider = AdminProviderQuickSetupProviderSnapshot;
export type AdminProviderQuickSetupSelectionResult =
  AdminProviderQuickSetupSelectionRequiredResult;
export type AdminProviderQuickSetupSubmit = AdminProviderQuickSetupRequest;
export type AdminProviderQuickSetupClearSubmit = AdminProviderQuickSetupClearRequest;
export type {
  AdminProviderQuickSetupClearResult,
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

const profileIds = new Set(["balanced", "deep", "fast"]);

const forbiddenResponseKeys = new Set([
  "apiKey",
  "apiRoot",
  "body",
  "catalog",
  "ciphertext",
  "connectionId",
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

function provider(value: unknown): AdminProviderQuickSetupProvider | null {
  if (!record(value) || !exactKeys(value, [
    "provider",
    "providerDisplayName",
    "quickSetupAssigned",
    "state",
    "stateToken",
    ...(value.model === undefined ? [] : ["model"])
  ]) || !providerId(value.provider) || !safeText(value.providerDisplayName, 80) ||
    typeof value.quickSetupAssigned !== "boolean" ||
    !safeText(value.stateToken, 512) ||
    (value.state !== "advanced_required" && value.state !== "disabled" &&
      value.state !== "needs_attention" &&
      value.state !== "not_configured" && value.state !== "ready") ||
    (value.state === "ready" ? !model(value.model) : value.model !== undefined)) {
    return null;
  }
  return {
    ...(value.model === undefined ? {} : { model: value.model as AdminProviderQuickSetupModel }),
    provider: value.provider,
    providerDisplayName: value.providerDisplayName,
    quickSetupAssigned: value.quickSetupAssigned,
    state: value.state,
    stateToken: value.stateToken
  };
}

function configuredConnection(value: unknown): AdminProviderQuickSetupConnection | null {
  if (!record(value) || !exactKeys(value, [
    "activeModelCount",
    "displayName",
    "enabled",
    "family",
    "id"
  ]) || !Number.isSafeInteger(value.activeModelCount) || Number(value.activeModelCount) < 0 ||
    Number(value.activeModelCount) > 10_000 || !safeText(value.displayName, 160) ||
    typeof value.enabled !== "boolean" || !safeText(value.family, 80) ||
    !safeText(value.id, 160)) {
    return null;
  }
  return value as AdminProviderQuickSetupConnection;
}

function snapshot(value: unknown): AdminProviderQuickSetupSnapshot | null {
  if (!record(value) || containsForbiddenMaterial(value) ||
    !exactKeys(value, ["configuredConnections", "providers", "suggestedProvider"]) ||
    (value.suggestedProvider !== null && !providerId(value.suggestedProvider)) ||
    !Array.isArray(value.configuredConnections) || value.configuredConnections.length > 128 ||
    !Array.isArray(value.providers) || value.providers.length !== 4) {
    return null;
  }
  const configuredConnections = value.configuredConnections.map(configuredConnection);
  if (configuredConnections.some((entry) => entry === null) ||
    new Set(configuredConnections.map((entry) => entry!.id)).size !==
      configuredConnections.length) return null;
  const providers = value.providers.map(provider);
  if (providers.some((entry) => entry === null)) return null;
  const ids = providers.map((entry) => entry!.provider);
  if (new Set(ids).size !== providers.length ||
    !["openai", "anthropic", "gemini", "openrouter"].every(
      (id) => ids.includes(id as AdminProviderQuickSetupId)
    )) {
    return null;
  }
  return {
    configuredConnections: configuredConnections as AdminProviderQuickSetupConnection[],
    providers: providers as AdminProviderQuickSetupProvider[],
    suggestedProvider: value.suggestedProvider
  };
}

function choice(value: unknown): value is AdminProviderQuickSetupChoice {
  return record(value) && exactKeys(value, ["candidateId", "displayName"]) &&
    safeText(value.candidateId, 256) && safeText(value.displayName);
}

function result(value: unknown): AdminProviderQuickSetupResult | null {
  if (!record(value) || containsForbiddenMaterial(value) || typeof value.outcome !== "string") return null;
  if (value.outcome === "ready" && exactKeys(value, [
    "checkedAt",
    "defaultChanged",
    "model",
    "models",
    "outcome",
    "profilesFilled",
    "provider",
    "providerDisplayName",
    ...(value.search === undefined ? [] : ["search"])
  ]) && timestamp(value.checkedAt) && typeof value.defaultChanged === "boolean" &&
    model(value.model) && Array.isArray(value.models) && value.models.length > 0 &&
    value.models.length <= 16 && value.models.every(model) &&
    new Set(value.models.map((entry) => (entry as AdminProviderQuickSetupModel).displayName)).size ===
      value.models.length &&
    providerId(value.provider) && safeText(value.providerDisplayName, 80) &&
    searchReceipt(value.search ?? null) &&
    Array.isArray(value.profilesFilled) &&
    value.profilesFilled.every((entry) => typeof entry === "string" && profileIds.has(entry)) &&
    new Set(value.profilesFilled).size === value.profilesFilled.length) {
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

function clearResult(value: unknown): AdminProviderQuickSetupClearResult | null {
  return record(value) && !containsForbiddenMaterial(value) && exactKeys(value, [
    "credentialRetained",
    "outcome",
    "provider",
    "providerDisplayName"
  ]) && value.credentialRetained === true && value.outcome === "assignment_cleared" &&
    providerId(value.provider) && safeText(value.providerDisplayName, 80)
    ? value as AdminProviderQuickSetupClearResult
    : null;
}

function errorCode(value: unknown, fallback: string): string {
  return record(value) && exactKeys(value, ["error"]) && safeText(value.error, 128)
    ? value.error
    : fallback;
}

async function request<T>(
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminProviderQuickSetupClientResult<T>> {
  try {
    const response = await fetcher("/api/admin/providers/quick-setup", {
      credentials: "same-origin",
      ...init
    });
    const value = await response.json().catch(() => null);
    if (containsForbiddenMaterial(value)) {
      return { error: { code: "provider_quick_setup_response_invalid" }, ok: false };
    }
    if (!response.ok) {
      return { error: { code: errorCode(value, "provider_admin_action_failed") }, ok: false };
    }
    const data = decode(value);
    return data
      ? { data, ok: true }
      : { error: { code: "provider_quick_setup_response_invalid" }, ok: false };
  } catch {
    return { error: { code: "network_error" }, ok: false };
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
  signal?: AbortSignal
) {
  return request({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal
  }, result, fetcher);
}

export function clearAdminProviderQuickSetupAssignment(
  body: AdminProviderQuickSetupClearSubmit,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
) {
  return request({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "DELETE",
    signal
  }, clearResult, fetcher);
}

export function adminProviderQuickSetupErrorMessage(
  error: AdminProviderQuickSetupClientError
): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage providers.",
    network_error: "Could not reach the provider setup API. Try again.",
    provider_admin_action_failed: "Provider setup could not be completed. Your existing configuration was not changed.",
    provider_credential_test_failed: "The provider rejected the key or its account catalog could not be reached.",
    provider_draft_stale: "Provider settings changed in another request. Refresh and try again.",
    provider_quick_setup_advanced_required: "This provider has configuration that must be managed in Connections.",
    provider_quick_setup_response_invalid: "The provider setup API returned an unexpected response. Refresh and try again.",
    provider_quick_setup_selection_invalid: "That model choice is no longer available. Test the key again.",
    provider_quick_setup_unsupported_catalog: "No supported answer model is available for this key. Continue in Connections.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  return messages[error.code] ?? messages.provider_admin_action_failed!;
}
