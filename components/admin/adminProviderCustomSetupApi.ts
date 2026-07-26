import type {
  AdminProviderCustomSetupReadyResult,
  AdminProviderCustomSetupRequest
} from "@/lib/contracts/adminProviderCustomSetup";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminProviderCustomSetupClientError = Readonly<{
  code: string;
}>;

export type AdminProviderCustomSetupClientResult =
  | Readonly<{ data: AdminProviderCustomSetupReadyResult; ok: true }>
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
      "outcome",
      "providerModelId"
    ]) ||
    (value.authenticationMode !== "bearer" && value.authenticationMode !== "none") ||
    !timestamp(value.checkedAt) ||
    !safeText(value.connectionDisplayName, 160) ||
    !safeText(value.connectionId, 128) ||
    typeof value.defaultChanged !== "boolean" ||
    !safeText(value.modelDisplayName, 160) ||
    value.outcome !== "ready" ||
    !safeText(value.providerModelId, 128)
  ) {
    return null;
  }
  return value as AdminProviderCustomSetupReadyResult;
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
