import {
  decodeAdminSearchCatalog,
  type AdminSearchCatalog,
  type AdminSearchDraft
} from "@/lib/contracts/adminSearch";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminSearchApiResult =
  | Readonly<{ ok: true; search: AdminSearchCatalog; selectedIntegrationId?: string }>
  | Readonly<{ error: string; ok: false }>;

async function read(response: Response): Promise<AdminSearchApiResult> {
  const value = await response.json().catch(() => null);
  const decoded = response.ok ? decodeAdminSearchCatalog(value) : null;
  if (decoded) {
    const selectedIntegrationId = typeof value === "object" && value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).selectedIntegrationId === "string"
      ? String((value as Record<string, unknown>).selectedIntegrationId)
      : undefined;
    return {
      ok: true,
      search: decoded,
      ...(selectedIntegrationId ? { selectedIntegrationId } : {})
    };
  }
  const error = typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).error === "string"
    ? String((value as Record<string, unknown>).error)
    : response.ok
      ? "search_catalog_malformed"
      : "search_admin_action_failed";
  return { error, ok: false };
}

async function request(
  path: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch
): Promise<AdminSearchApiResult> {
  try {
    return await read(await fetcher(path, init));
  } catch {
    return { error: "network_error", ok: false };
  }
}

function json(body: unknown, method: "PATCH" | "POST"): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  };
}

export function requestAdminSearchCatalog(fetcher?: Fetcher): Promise<AdminSearchApiResult> {
  return request("/api/admin/search", {}, fetcher);
}

export function createAdminSearchIntegration(input: Readonly<{
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
}>, fetcher?: Fetcher): Promise<AdminSearchApiResult> {
  return request("/api/admin/search", json(input, "POST"), fetcher);
}

export function updateAdminSearchPolicy(input: Readonly<{
  defaultPlan: AdminSearchCatalog["policy"]["defaultPlan"];
  expectedVersion: number;
}>, fetcher?: Fetcher): Promise<AdminSearchApiResult> {
  return request("/api/admin/search", json(input, "PATCH"), fetcher);
}

export function updateAdminSearchIntegration(input: Readonly<{
  description: string;
  displayName: string;
  draft: AdminSearchDraft;
  expectedDraftVersion: number;
  id: string;
}>, fetcher?: Fetcher): Promise<AdminSearchApiResult> {
  const { id, ...body } = input;
  return request(`/api/admin/search/${encodeURIComponent(id)}`, json(body, "PATCH"), fetcher);
}

export function runAdminSearchAction(input: Readonly<{
  action: "activate" | "archive" | "disable" | "enable" | "test";
  confirmed?: boolean;
  id: string;
}>, fetcher?: Fetcher): Promise<AdminSearchApiResult> {
  const { id, ...body } = input;
  return request(
    `/api/admin/search/${encodeURIComponent(id)}/actions`,
    json(body, "POST"),
    fetcher
  );
}

export function adminSearchErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    network_error: "The Search control plane could not be reached.",
    search_activation_evidence_missing: "Test this exact draft successfully before activation.",
    search_admin_action_failed: "The Search action failed.",
    search_catalog_malformed: "The Search catalog response was invalid.",
    search_configuration_invalid: "Review the Search configuration and bounded limits.",
    search_configuration_unavailable: "This Search source has no editable configuration.",
    search_default_unavailable: "Choose only enabled, ready Search sources that can work together.",
    search_draft_stale: "This configuration changed elsewhere. Reload and apply your edit again.",
    search_integration_material_identity_changed: "The Search connection cannot change after this source is in use. Add a new source instead.",
    search_provider_model_not_available: "Choose an enabled provider model that supports Search for this source.",
    search_policy_stale: "The organization Search default changed elsewhere. Reload and apply your edit again.",
    search_system_integration_forbidden: "This built-in Search source cannot be archived.",
    search_test_failed: "The Search test did not produce a usable result."
  };
  return messages[code] ?? code.replaceAll("_", " ");
}
