import { decodeAdminProviderCapabilityAttempts } from "@/lib/contracts/adminProviders";
import type {
  AdminImageDiscoveredModel,
  AdminImageDiscoveredEndpoint,
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderCheckRun,
  AdminProviderConnection
} from "@/lib/contracts/adminProviders";
import { normalizeImageModelConfiguration } from "@/lib/contracts/imageGeneration";
import { ADMIN_PROVIDER_SETUP_STREAM_TYPE, type AdminProviderSetupProgress } from "@/lib/contracts/adminProviderSetupProgress";
import { readAdminProviderSetupResponse } from "./adminProviderSetupStream";
import {
  ADMIN_PROVIDER_CAPABILITY_CHECKS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
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

function optionalResponseTimeoutSeconds(value: unknown): boolean {
  return value === undefined || (
    Number.isSafeInteger(value) &&
    Number(value) >= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS &&
    Number(value) <= ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
  );
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
    typeof value.draftConfig.answerSelectable === "boolean" &&
    (value.draftConfig.modelClass === "answer" ||
      value.draftConfig.modelClass === "embedding" ||
      value.draftConfig.modelClass === "reranker" || value.draftConfig.modelClass === "image") &&
    optionalResponseTimeoutSeconds(value.draftConfig.responseTimeoutSeconds) &&
    typeof value.draftConfig.upstreamModelId === "string";
}

const checkRunStates = new Set(["cancelled", "completed", "interrupted", "running"]);
const checkRunReasons = new Set(["credential", "model", "requested", "setup"]);

export function isAdminProviderCheckRun(value: unknown): value is AdminProviderCheckRun {
  const text = (entry: unknown, maxLength = 256) => typeof entry === "string" && entry.length > 0 &&
    entry.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(entry);
  const ids = (entry: unknown) => Array.isArray(entry) && entry.length <= 1_000 && entry.every((id) => text(id));
  return record(value) && Object.keys(value).every((key) => [
    "capabilityProgress", "setup", "skipped", "credentialId", "current", "done", "failed",
    "finishedAt", "id", "inFlight", "reason", "startedAt", "state", "total", "results"
  ].includes(key)) && text(value.id) && (text(value.credentialId) ||
    value.state === "interrupted" && value.credentialId === "" && value.total === 0 && value.done === 0) &&
    typeof value.state === "string" && checkRunStates.has(value.state) &&
    typeof value.reason === "string" && checkRunReasons.has(value.reason) &&
    Number.isSafeInteger(value.done) && Number(value.done) >= 0 &&
    Number.isSafeInteger(value.total) && Number(value.total) >= Number(value.done) && Number(value.total) <= 1_000 &&
    (value.current === null || text(value.current)) &&
    ids(value.inFlight) && ids(value.failed) &&
    (value.skipped === undefined || ids(value.skipped)) &&
    (value.results === undefined || Array.isArray(value.results) && value.results.length <= 1_000 &&
      new Set(value.results.map((entry) => record(entry) ? entry.providerModelId : null)).size === value.results.length &&
      value.results.every((entry) => record(entry) && (entry.attempts === undefined || decodeAdminProviderCapabilityAttempts(entry.attempts) !== null) && Object.keys(entry).every((key) => ["providerModelId", "state", "checks", "attempts"].includes(key)) &&
        text(entry.providerModelId) && ["saved", "partial", "unavailable", "save_failed", "check_failed", "cancelled", "stale"].includes(String(entry.state)) &&
        (entry.checks === undefined || record(entry.checks) && Object.entries(entry.checks).every(([key, state]) =>
          ADMIN_PROVIDER_CAPABILITY_CHECKS.includes(key as typeof ADMIN_PROVIDER_CAPABILITY_CHECKS[number]) &&
          ["verified", "rejected", "unsupported", "incomplete", "not_checked"].includes(String(state)))))) &&
    (value.capabilityProgress === undefined || record(value.capabilityProgress) &&
      Object.keys(value.capabilityProgress).sort().join(",") === "capability,completed,providerModelId,total" &&
      ADMIN_PROVIDER_CAPABILITY_CHECKS.includes(value.capabilityProgress.capability as typeof ADMIN_PROVIDER_CAPABILITY_CHECKS[number]) &&
      text(value.capabilityProgress.providerModelId) &&
      Number.isSafeInteger(value.capabilityProgress.completed) && Number(value.capabilityProgress.completed) >= 0 &&
      Number.isSafeInteger(value.capabilityProgress.total) && Number(value.capabilityProgress.total) > 0 &&
      Number(value.capabilityProgress.total) <= ADMIN_PROVIDER_CAPABILITY_CHECKS.length &&
      Number(value.capabilityProgress.completed) <= Number(value.capabilityProgress.total)) &&
    (value.setup === undefined || record(value.setup) && (
      value.setup.state === "running" && Object.keys(value.setup).join(",") === "state" ||
      Object.keys(value.setup).sort().join(",") === "defaults,search,state" &&
      ["completed", "partial"].includes(String(value.setup.state)) && Array.isArray(value.setup.defaults) &&
        value.setup.defaults.length <= 16 && value.setup.defaults.every((label) => text(label, 512)) &&
        ["ready", "failed", "skipped"].includes(String(value.setup.search)))) &&
    text(value.startedAt) &&
    (value.finishedAt === null || text(value.finishedAt));
}

function isConnection(value: unknown): value is AdminProviderConnection {
  return record(value) && typeof value.id === "string" && typeof value.displayName === "string" &&
    (value.checkRun === undefined || value.checkRun === null || isAdminProviderCheckRun(value.checkRun)) &&
    typeof value.family === "string" && typeof value.enabled === "boolean" &&
    typeof value.draftVersion === "number" && record(value.draftConfig) &&
    (value.draftConfig.authenticationMode === "bearer" ||
      value.draftConfig.authenticationMode === "none") &&
    optionalResponseTimeoutSeconds(value.draftConfig.responseTimeoutSeconds) &&
    Array.isArray(value.credentials) && value.credentials.every(isCredential) &&
    Array.isArray(value.models) && value.models.every(isModel) &&
    Array.isArray(value.assignments) && Array.isArray(value.draftChecks) &&
    Array.isArray(value.activeChecks) && Array.isArray(value.userAssignments);
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
    "maxOutputTokens",
    "toolCalling",
    "vision",
    "parallelToolCalls",
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
    (capabilities.maxOutputTokens === undefined ||
      (Number.isInteger(capabilities.maxOutputTokens) && Number(capabilities.maxOutputTokens) > 0 &&
        Number(capabilities.maxOutputTokens) <= 10_000_000)) &&
    ["toolCalling", "vision", "parallelToolCalls"].every((key) =>
      capabilities[key] === undefined || typeof capabilities[key] === "boolean") &&
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
  fetcher: Fetcher,
  nonJsonNotFoundCode?: string
): Promise<AdminProviderClientResult<T>> {
  try {
    const response = await fetcher(url, { credentials: "same-origin", ...init });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const fallback = response.status === 404 && value === null && nonJsonNotFoundCode
        ? nonJsonNotFoundCode
        : "provider_admin_action_failed";
      return { error: clientError(value, fallback), ok: false };
    }
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
    fetcher,
    "provider_admin_route_unavailable"
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
    fetcher,
    "provider_admin_route_unavailable"
  );
}

function validImageCatalogEntry(value: unknown): boolean {
  if (!record(value) || containsSecretMaterial(value)) return false;
  try { normalizeImageModelConfiguration(value.image); return true; } catch { return false; }
}

export function discoverAdminImageModels(connectionId: string, credentialId: string, fetcher: Fetcher = fetch) {
  return request<AdminImageDiscoveredModel[]>(`/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", { action: "discover_image_models", credentialId }),
    (value) => record(value) && Array.isArray(value.models) && value.models.length <= 1000 && value.models.every((entry: unknown) =>
      record(entry) && validImageCatalogEntry(entry) && typeof entry.id === "string" && typeof entry.name === "string" &&
      typeof entry.editing === "boolean" && (entry.source === "catalog" || entry.source === "preset")) ? value.models as AdminImageDiscoveredModel[] : null,
    fetcher, "provider_admin_route_unavailable");
}

export function discoverAdminImageEndpoints(connectionId: string, credentialId: string, modelId: string, fetcher: Fetcher = fetch) {
  return request<AdminImageDiscoveredEndpoint[]>(`/api/admin/providers/${encoded(connectionId)}/actions`,
    json("POST", { action: "discover_image_endpoints", credentialId, modelId }),
    (value) => record(value) && Array.isArray(value.endpoints) && value.endpoints.length <= 128 && value.endpoints.every((entry: unknown) =>
      record(entry) && validImageCatalogEntry(entry) && typeof entry.tag === "string" && typeof entry.name === "string") ? value.endpoints as AdminImageDiscoveredEndpoint[] : null,
    fetcher, "provider_admin_route_unavailable");
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
    fetcher,
    "provider_admin_route_unavailable"
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
    fetcher,
    "provider_admin_route_unavailable"
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
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  onProgress?: (value: AdminProviderSetupProgress) => void
) {
  return modelSetupRequest(
    `/api/admin/providers/${encoded(connectionId)}/models`,
    json("POST", body),
    fetcher, signal, onProgress
  );
}

export function updateAdminProviderModel(
  connectionId: string,
  modelId: string,
  body: unknown,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  onProgress?: (value: AdminProviderSetupProgress) => void
) {
  return modelSetupRequest(
    `/api/admin/providers/${encoded(connectionId)}/models/${encoded(modelId)}`,
    json("PATCH", body),
    fetcher, signal, onProgress
  );
}

async function modelSetupRequest(
  url: string,
  init: RequestInit,
  fetcher: Fetcher,
  signal?: AbortSignal,
  onProgress?: (value: AdminProviderSetupProgress) => void
): Promise<AdminProviderClientResult<AdminProviderConnection[]>> {
  if (!onProgress && !signal) return request(url, init, catalog, fetcher);
  try {
    const headers = new Headers(init.headers);
    if (onProgress) headers.set("accept", ADMIN_PROVIDER_SETUP_STREAM_TYPE);
    const response = await fetcher(url, {
      ...init, credentials: "same-origin", signal,
      headers
    });
    const result = await readAdminProviderSetupResponse(response, onProgress);
    if (!result.ok) return { ok: false, error: clientError(result.value, "provider_admin_action_failed") };
    const data = catalog(result.value);
    return data ? { ok: true, data } : { ok: false, error: clientError(null, "provider_admin_response_invalid") };
  } catch {
    return { ok: false, error: clientError(null, signal?.aborted ? "request_aborted" : "network_error") };
  }
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

/** Progress of one background capability check (PRD B3); an unknown id reads as interrupted. */
export function getAdminProviderCheckRun(
  connectionId: string,
  runId: string,
  fetcher: Fetcher = fetch
) {
  return request(
    `/api/admin/providers/${encoded(connectionId)}/actions?run=${encoded(runId)}`,
    { method: "GET" },
    (value) => record(value) && isAdminProviderCheckRun(value.run) ? value.run : null,
    fetcher,
    "provider_admin_route_unavailable"
  );
}

export function adminProviderErrorMessage(error: AdminProviderClientError): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage providers.",
    json_required: "The provider request format was not accepted. Refresh and try again.",
    network_error: "Could not reach the provider administration API.",
    request_aborted: "Checking stopped. Saved results are kept; retry unfinished checks from the model list.",
    provider_activation_empty: "Add at least one enabled model and referenced credential before activation.",
    provider_activation_evidence_missing: "Every default or group key must be turned on and working before the change can be applied.",
    provider_activation_unavailable_confirmation_required: "A configured model ID is absent from one or more referenced key catalogs. Review the setup or confirm the override.",
    provider_check_run_not_found: "This check is no longer running.",
    provider_active_tuple_not_found: "This model and key pair is no longer usable.",
    provider_admin_action_failed: "The provider action could not be completed.",
    provider_admin_route_unavailable: "The provider action route is unavailable in this app process. Restart the development app and try again.",
    provider_admin_response_invalid: "The provider API returned an unexpected response. Refresh and try again.",
    provider_configuration_invalid: "Review the provider fields and try again.",
    provider_connection_not_found: "This provider connection no longer exists.",
    provider_credential_label_taken: "A key with this name already exists on this provider.",
    provider_credential_not_found: "This key no longer exists or has no usable value.",
    provider_credential_test_failed: "The provider rejected this key. Check the key and try again.",
    provider_delete_conflict: "Remove the listed references or disable this resource instead.",
    provider_discovery_failed: "Model discovery failed. Check the credential, endpoint, and account access.",
    provider_discovery_unsupported: "Remote model discovery is available only for OpenRouter and Custom compatible connections.",
    provider_draft_stale: "This provider changed in another window. Refresh and try again.",
    provider_endpoint_keys_required: "Enter every saved key again for the new endpoint. The previous settings and keys were kept.",
    provider_draft_test_failed: "The check could not be completed. Earlier results were kept.",
    provider_family_adapter_mismatch: "The selected protocol does not match this provider family.",
    provider_group_not_found: "This group no longer exists.",
    provider_model_not_found: "This model no longer exists.",
    provider_model_class_immutable: "A model cannot change between chat, embedding and reranker classes; add a new model instead.",
    provider_paid_test_confirmation_required: "Confirm the provider requests before running the check.",
    provider_revoke_confirmation_required: "This key action requires confirmation.",
    provider_refresh_failed: "The check could not be completed. Saved capability results were kept.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  const blockerLabels: Record<string, string> = {
    assistants: "assistants",
    installation_default: "installation default",
    system_model: "utility model role"
  };
  const base = messages[error.code] ?? "The provider action could not be completed. Refresh and try again.";
  if (!error.blockers.length) return base;
  return `${base} ${error.blockers.map(({ count, kind }) => `${blockerLabels[kind] ?? kind}: ${count}`).join(", ")}.`;
}
