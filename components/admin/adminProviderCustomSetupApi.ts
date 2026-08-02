import type {
  AdminProviderCustomDiscoveryRequest,
  AdminProviderCustomDiscoveryResult,
  AdminProviderCustomSetupReadyResult,
  AdminProviderCustomSetupRequest
} from "@/lib/contracts/adminProviderCustomSetup";
import { MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS } from "@/lib/contracts/adminProviderCustomSetup";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminProviderCustomSetupClientError = Readonly<{
  code: string;
}>;

export type AdminProviderCustomSetupClientResult =
  | Readonly<{ data: AdminProviderCustomSetupReadyResult; ok: true }>
  | Readonly<{ error: AdminProviderCustomSetupClientError; ok: false }>;

export type AdminProviderCustomDiscoveryClientResult =
  | Readonly<{ data: AdminProviderCustomDiscoveryResult; ok: true }>
  | Readonly<{ error: AdminProviderCustomSetupClientError; ok: false }>;

const forbiddenResponseKeys = new Set([
  "apiKey",
  "apiRoot",
  "body",
  "ciphertext",
  "draftSecretEnvelope",
  "headers",
  "password",
  "rawBody",
  "secret",
  "secretEnvelope",
  "versionId"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every(
    (key, index) => key === expected[index]
  );
}

function containsForbiddenMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenMaterial);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    forbiddenResponseKeys.has(key) || containsForbiddenMaterial(entry)
  );
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function searchReceipt(
  value: unknown
): value is AdminProviderCustomSetupReadyResult["search"] {
  return value === null || (
    record(value) && exactKeys(value, ["displayName", "status"]) &&
    safeText(value.displayName, 160) &&
    (value.status === "needs_attention" || value.status === "ready")
  );
}

function ready(value: unknown): AdminProviderCustomSetupReadyResult | null {
  if (
    !record(value) ||
    containsForbiddenMaterial(value) ||
    !exactKeys(value, [
      "authenticationMode",
      "checkedAt",
      "connectionDisplayName",
      "connectionId",
      "defaultChanged",
      "modelDisplayName",
      "models",
      "outcome",
      "providerModelId",
      "search"
    ]) ||
    (value.authenticationMode !== "bearer" && value.authenticationMode !== "none") ||
    !timestamp(value.checkedAt) ||
    !safeText(value.connectionDisplayName, 160) ||
    !safeText(value.connectionId, 128) ||
    typeof value.defaultChanged !== "boolean" ||
    !safeText(value.modelDisplayName, 160) ||
    !Array.isArray(value.models) ||
    value.models.length < 1 ||
    value.models.length > MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS ||
    value.models.some((model) =>
      !record(model) ||
      !exactKeys(model, ["modelDisplayName", "providerModelId"]) ||
      !safeText(model.modelDisplayName, 160) ||
      !safeText(model.providerModelId, 128)
    ) ||
    !record(value.models[0]) ||
    value.models[0].modelDisplayName !== value.modelDisplayName ||
    value.models[0].providerModelId !== value.providerModelId ||
    value.outcome !== "ready" ||
    !safeText(value.providerModelId, 128) ||
    !searchReceipt(value.search)
  ) {
    return null;
  }
  return value as AdminProviderCustomSetupReadyResult;
}

function discoveredCapabilities(value: unknown): boolean {
  if (!record(value)) return false;
  const allowed = new Set([
    "contextWindow",
    "defaultMaxOutputTokens",
    "defaultReasoningEffort",
    "defaultReasoningMode",
    "reasoning",
    "reasoningEfforts",
    "reasoningModes"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const controls = (candidate: unknown) => Array.isArray(candidate) &&
    candidate.length >= 1 && candidate.length <= 16 &&
    candidate.every((entry) => safeText(entry, 32) && entry === entry.trim()) &&
    new Set(candidate).size === candidate.length;
  const hasReasoningDetails = value.defaultReasoningEffort !== undefined ||
    value.defaultReasoningMode !== undefined || value.reasoningEfforts !== undefined ||
    value.reasoningModes !== undefined;
  return (value.contextWindow === undefined ||
      (Number.isInteger(value.contextWindow) && Number(value.contextWindow) > 0 &&
        Number(value.contextWindow) <= 10_000_000)) &&
    (value.defaultMaxOutputTokens === undefined ||
      (Number.isInteger(value.defaultMaxOutputTokens) &&
        Number(value.defaultMaxOutputTokens) > 0 &&
        Number(value.defaultMaxOutputTokens) <= 10_000_000)) &&
    (value.reasoning === undefined || typeof value.reasoning === "boolean") &&
    (!hasReasoningDetails || value.reasoning === true) &&
    (value.reasoningEfforts === undefined || controls(value.reasoningEfforts)) &&
    (value.reasoningModes === undefined || controls(value.reasoningModes)) &&
    (value.defaultReasoningEffort === undefined ||
      (typeof value.defaultReasoningEffort === "string" &&
        Array.isArray(value.reasoningEfforts) &&
        value.reasoningEfforts.includes(value.defaultReasoningEffort))) &&
    (value.defaultReasoningMode === undefined ||
      (typeof value.defaultReasoningMode === "string" &&
        Array.isArray(value.reasoningModes) &&
        value.reasoningModes.includes(value.defaultReasoningMode)));
}

function discovery(value: unknown): AdminProviderCustomDiscoveryResult | null {
  if (
    !record(value) ||
    containsForbiddenMaterial(value) ||
    !exactKeys(value, ["checkedAt", "modelCount", "models", "source", "status"]) ||
    !timestamp(value.checkedAt) ||
    !Number.isInteger(value.modelCount) ||
    Number(value.modelCount) < 0 ||
    Number(value.modelCount) > 1_000 ||
    !Array.isArray(value.models) ||
    value.models.length !== value.modelCount ||
    value.models.some((model) =>
      !record(model) ||
      !exactKeys(model, ["capabilities", "id"]) ||
      !discoveredCapabilities(model.capabilities) ||
      !safeText(model.id, 256)
    ) ||
    value.source !== "models_catalog" ||
    value.status !== "valid"
  ) {
    return null;
  }
  return value as AdminProviderCustomDiscoveryResult;
}

export async function discoverAdminProviderCustomModels(
  body: AdminProviderCustomDiscoveryRequest,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<AdminProviderCustomDiscoveryClientResult> {
  try {
    const response = await fetcher("/api/admin/providers/custom-setup/discover", {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: {
          code: record(value) && typeof value.error === "string"
            ? value.error
            : "provider_custom_setup_discovery_failed"
        },
        ok: false
      };
    }
    const data = discovery(value);
    return data
      ? { data, ok: true }
      : {
          error: { code: "provider_custom_setup_discovery_response_invalid" },
          ok: false
        };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { error: { code: "request_aborted" }, ok: false };
    }
    return { error: { code: "network_error" }, ok: false };
  }
}

export async function submitAdminProviderCustomSetup(
  body: AdminProviderCustomSetupRequest,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<AdminProviderCustomSetupClientResult> {
  try {
    const response = await fetcher("/api/admin/providers/custom-setup", {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: {
          code: record(value) && typeof value.error === "string"
            ? value.error
            : "provider_custom_setup_failed"
        },
        ok: false
      };
    }
    const data = ready(value);
    return data
      ? { data, ok: true }
      : {
          error: { code: "provider_custom_setup_response_invalid" },
          ok: false
        };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { error: { code: "request_aborted" }, ok: false };
    }
    return { error: { code: "network_error" }, ok: false };
  }
}

export function adminProviderCustomSetupErrorMessage(
  error: AdminProviderCustomSetupClientError
): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage providers.",
    network_error: "Could not reach the provider administration API.",
    provider_configuration_invalid: "Review the endpoint, model, and authentication fields.",
    provider_custom_setup_catalog_unavailable:
      "The setup was tested but could not be made available to your account.",
    provider_custom_setup_failed: "The custom provider could not be configured.",
    provider_custom_setup_discovery_failed:
      "This endpoint did not return a usable /models catalog. You can still enter a model ID manually.",
    provider_custom_setup_discovery_response_invalid:
      "The model catalog response was not safe to use. Enter a model ID manually.",
    provider_custom_setup_response_invalid:
      "The provider API returned an unexpected response. Refresh and try again.",
    provider_custom_setup_stale:
      "Your administrator session or defaults changed. Review the fields and try again.",
    provider_custom_setup_test_failed:
      "The endpoint did not complete the exact model test. Check the URL, model ID, and key.",
    unauthorized: "Sign in again before configuring a provider."
  };
  return messages[error.code] ?? "The custom provider could not be configured.";
}
