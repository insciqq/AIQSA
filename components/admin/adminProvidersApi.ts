import type {
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderCredentialTestResult,
  AdminProviderDraftCheck
} from "@/lib/contracts/adminProviders";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminProviderClientError = Readonly<{
  blockers: ReadonlyArray<{ count: number; kind: string }>;
  code: string;
  resourceIds: string[];
}>;

export type AdminProviderClientResult<T> =
  | { data: T; ok: true }
  | { error: AdminProviderClientError; ok: false };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const forbiddenSecretKeys = new Set([
  "apiKey",
  "ciphertext",
  "draftSecretEnvelope",
  "password",
  "secret",
  "secretEnvelope"
]);

function containsSecretMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    forbiddenSecretKeys.has(key) || containsSecretMaterial(entry)
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCredential(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && typeof value.label === "string" &&
    typeof value.enabled === "boolean" && typeof value.draftSecretConfigured === "boolean" &&
    typeof value.draftVersion === "number" &&
    (value.activeVersion === null || (record(value.activeVersion) &&
      typeof value.activeVersion.id === "string" && typeof value.activeVersion.version === "number"));
}

function isModel(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && typeof value.displayName === "string" &&
    typeof value.enabled === "boolean" && typeof value.draftVersion === "number" &&
    record(value.draftConfig) && typeof value.draftConfig.adapterKind === "string" &&
    typeof value.draftConfig.upstreamModelId === "string";
}

function isConnection(value: unknown): value is AdminProviderConnection {
  return record(value) && typeof value.id === "string" && typeof value.displayName === "string" &&
    typeof value.family === "string" && typeof value.enabled === "boolean" &&
    typeof value.draftVersion === "number" && record(value.draftConfig) &&
    Array.isArray(value.credentials) && value.credentials.every(isCredential) &&
    Array.isArray(value.models) && value.models.every(isModel) &&
    Array.isArray(value.assignments) && Array.isArray(value.draftChecks) &&
    Array.isArray(value.activeChecks) &&
    (value.userAssignments === undefined || Array.isArray(value.userAssignments));
}

function isDiscoveredModel(value: unknown): value is AdminOpenRouterDiscoveredModel {
  return record(value) && typeof value.id === "string" && typeof value.name === "string" &&
    stringArray(value.inputModalities) && stringArray(value.outputModalities) &&
    stringArray(value.supportedParameters) && record(value.pricing);
}

function isCompatibleDiscoveredModel(value: unknown): value is AdminCompatibleDiscoveredModel {
  if (!record(value) || Object.keys(value).sort().join(",") !== "capabilities,id" ||
    !record(value.capabilities)) return false;
  const capabilities = value.capabilities;
  const allowed = new Set([
    "contextWindow",
    "defaultMaxOutputTokens",
    "defaultReasoningEffort",
    "defaultReasoningMode",
    "reasoning",
    "reasoningEfforts",
    "reasoningModes"
  ]);
  const controls = (candidate: unknown) => Array.isArray(candidate) &&
    candidate.length >= 1 && candidate.length <= 16 &&
    candidate.every((entry) => typeof entry === "string" && entry === entry.trim() &&
      entry.length > 0 && entry.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(entry)) &&
    new Set(candidate).size === candidate.length;
  const hasReasoningDetails = capabilities.defaultReasoningEffort !== undefined ||
    capabilities.defaultReasoningMode !== undefined ||
    capabilities.reasoningEfforts !== undefined || capabilities.reasoningModes !== undefined;
  return Object.keys(capabilities).every((key) => allowed.has(key)) &&
    (capabilities.contextWindow === undefined ||
      (Number.isInteger(capabilities.contextWindow) && Number(capabilities.contextWindow) > 0 &&
        Number(capabilities.contextWindow) <= 10_000_000)) &&
    (capabilities.defaultMaxOutputTokens === undefined ||
      (Number.isInteger(capabilities.defaultMaxOutputTokens) &&
        Number(capabilities.defaultMaxOutputTokens) > 0 &&
        Number(capabilities.defaultMaxOutputTokens) <= 10_000_000)) &&
    (capabilities.reasoning === undefined || typeof capabilities.reasoning === "boolean") &&
    (!hasReasoningDetails || capabilities.reasoning === true) &&
    (capabilities.reasoningEfforts === undefined || controls(capabilities.reasoningEfforts)) &&
    (capabilities.reasoningModes === undefined || controls(capabilities.reasoningModes)) &&
    (capabilities.defaultReasoningEffort === undefined ||
      (typeof capabilities.defaultReasoningEffort === "string" &&
        Array.isArray(capabilities.reasoningEfforts) &&
        capabilities.reasoningEfforts.includes(capabilities.defaultReasoningEffort))) &&
    (capabilities.defaultReasoningMode === undefined ||
      (typeof capabilities.defaultReasoningMode === "string" &&
        Array.isArray(capabilities.reasoningModes) &&
        capabilities.reasoningModes.includes(capabilities.defaultReasoningMode))) &&
    typeof value.id === "string" && value.id.trim().length > 0 && value.id.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value.id);
}

function isDiscoveredEndpoint(value: unknown): value is AdminOpenRouterDiscoveredEndpoint {
  return record(value) && typeof value.tag === "string" && typeof value.name === "string" &&
    typeof value.providerName === "string" && stringArray(value.supportedParameters);
}

function clientError(value: unknown, fallback: string): AdminProviderClientError {
  const body = record(value) ? value : {};
  const blockers = Array.isArray(body.blockers)
    ? body.blockers.filter((entry): entry is { count: number; kind: string } =>
        record(entry) && typeof entry.kind === "string" && typeof entry.count === "number")
    : [];
  return {
    blockers,
    code: typeof body.error === "string" ? body.error : fallback,
    resourceIds: stringArray(body.resourceIds) ? body.resourceIds : []
  };
}

async function request<T>(
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T | null,
  fetcher: Fetcher
): Promise<AdminProviderClientResult<T>> {
  try {
    const response = await fetcher(url, { credentials: "same-origin", ...init });
    const value = await response.json().catch(() => null);
    if (!response.ok) return { error: clientError(value, "provider_admin_action_failed"), ok: false };
    const data = decode(value);
    return data === null
      ? { error: clientError(null, "provider_admin_response_invalid"), ok: false }
      : { data, ok: true };
  } catch {
    return { error: clientError(null, "network_error"), ok: false };
  }
}

function json(method: "DELETE" | "PATCH" | "POST", body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  };
}

function catalog(value: unknown): AdminProviderConnection[] | null {
  return record(value) && !containsSecretMaterial(value) &&
    Array.isArray(value.connections) && value.connections.every(isConnection)
    ? value.connections
    : null;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function getAdminProviderConnections(fetcher: Fetcher = fetch) {
  return request("/api/admin/providers", { method: "GET" }, catalog, fetcher);
}

export function createAdminProviderConnection(body: unknown, fetcher: Fetcher = fetch) {
  return request("/api/admin/providers", json("POST", body), catalog, fetcher);
}

export function updateAdminProviderConnection(
  connectionId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(`/api/admin/providers/${encoded(connectionId)}`, json("PATCH", body), catalog, fetcher);
}

export function deleteAdminProviderConnection(connectionId: string, fetcher: Fetcher = fetch) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}`,
    json("DELETE", { confirmed: true }),
    catalog,
    fetcher
  );
}

export function runAdminProviderConnectionAction(
  connectionId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", body),
    catalog,
    fetcher
  );
}

export function discoverAdminOpenRouterModels(
  connectionId: string,
  credentialId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", { action: "discover_models", credentialId }),
    (value) => record(value) && Array.isArray(value.models) && value.models.every(isDiscoveredModel)
      ? value.models
      : null,
    fetcher
  );
}

export function discoverAdminOpenRouterEndpoints(
  connectionId: string,
  credentialId: string,
  modelId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", { action: "discover_endpoints", credentialId, modelId }),
    (value) => record(value) && Array.isArray(value.endpoints) && value.endpoints.every(isDiscoveredEndpoint)
      ? value.endpoints
      : null,
    fetcher
  );
}

export function discoverAdminCompatibleModels(
  connectionId: string,
  credentialId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", { action: "discover_compatible_models", credentialId }),
    (value) => record(value) && !containsSecretMaterial(value) &&
      Array.isArray(value.models) && value.models.length <= 1_000 &&
      value.models.every(isCompatibleDiscoveredModel) &&
      new Set(value.models.map((model) => model.id)).size === value.models.length
      ? value.models
      : null,
    fetcher
  );
}

export function createAdminProviderCredential(
  connectionId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/credentials`,
    json("POST", body),
    catalog,
    fetcher
  );
}

export function testAdminProviderCredential(
  connectionId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/credential-tests`,
    json("POST", body),
    (value) => {
      if (!record(value) || !record(value.test) ||
        value.test.status !== "valid" ||
        typeof value.test.checkedAt !== "string" ||
        typeof value.test.connectionDraftVersion !== "number" ||
        typeof value.test.modelCount !== "number") {
        return null;
      }
      return value.test as AdminProviderCredentialTestResult;
    },
    fetcher
  );
}

export function updateAdminProviderCredential(
  connectionId: string,
  credentialId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/credentials/${encoded(credentialId)}`,
    json("PATCH", body),
    catalog,
    fetcher
  );
}

export function deleteAdminProviderCredential(
  connectionId: string,
  credentialId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/credentials/${encoded(credentialId)}`,
    json("DELETE", { confirmed: true }),
    catalog,
    fetcher
  );
}

export function createAdminProviderModel(
  connectionId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/models`,
    json("POST", body),
    catalog,
    fetcher
  );
}

export function updateAdminProviderModel(
  connectionId: string,
  modelId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/models/${encoded(modelId)}`,
    json("PATCH", body),
    catalog,
    fetcher
  );
}

export function deleteAdminProviderModel(
  connectionId: string,
  modelId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/models/${encoded(modelId)}`,
    json("DELETE", { confirmed: true }),
    catalog,
    fetcher
  );
}

export function testAdminProviderDraft(
  connectionId: string,
  modelId: string,
  body: unknown,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/models/${encoded(modelId)}/tests`,
    json("POST", body),
    (value) => record(value) && record(value.check) && typeof value.check.fingerprint === "string"
      ? value.check as AdminProviderDraftCheck
      : null,
    fetcher
  );
}

export function adminProviderErrorMessage(error: AdminProviderClientError): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage providers.",
    json_required: "The provider request format was not accepted. Refresh and try again.",
    network_error: "Could not reach the provider administration API.",
    provider_activation_empty: "Add at least one enabled model and referenced credential before activation.",
    provider_activation_evidence_missing: "Every default or group credential must be enabled and contain a usable key before activation.",
    provider_activation_unavailable_confirmation_required: "A configured model ID is absent from one or more referenced key catalogs. Review the setup or confirm the override.",
    provider_active_tuple_not_found: "This exact active model and credential tuple is no longer usable.",
    provider_admin_action_failed: "The provider action could not be completed.",
    provider_admin_response_invalid: "The provider API returned an unexpected response. Refresh and try again.",
    provider_configuration_invalid: "Review the provider fields and try again.",
    provider_connection_not_found: "This provider connection no longer exists.",
    provider_credential_not_found: "This credential no longer exists or has no usable key.",
    provider_credential_test_failed: "The provider rejected the key or its account catalog could not be reached.",
    provider_delete_conflict: "Remove the listed references or disable this resource instead.",
    provider_discovery_failed: "Model discovery failed. Check the credential, endpoint, and account access.",
    provider_discovery_unsupported: "Remote model discovery is available only for OpenRouter and Custom compatible connections.",
    provider_draft_stale: "The draft changed in another request. Refresh and retry.",
    provider_draft_test_failed: "The connectivity test failed. The prior active configuration was not changed.",
    provider_family_adapter_mismatch: "The selected protocol does not match this provider family.",
    provider_group_not_found: "This group no longer exists.",
    provider_model_not_found: "This model deployment no longer exists.",
    provider_paid_test_confirmation_required: "Confirm the paid tiny-generation request before testing.",
    provider_revoke_confirmation_required: "This destructive credential action requires confirmation.",
    provider_refresh_failed: "The active refresh failed transiently. Prior matching availability was preserved and marked for attention.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  const blockerLabels: Record<string, string> = {
    run_profiles: "run profiles"
  };
  const base = messages[error.code] ?? "The provider action could not be completed. Refresh and try again.";
  if (!error.blockers.length) return base;
  return `${base} ${error.blockers.map(({ count, kind }) => `${blockerLabels[kind] ?? kind}: ${count}`).join(", ")}.`;
}
