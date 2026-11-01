import { PROXY_ROUTES, type ProxyDeleteInput } from "@/lib/contracts/proxies";
import { decodeWorkspaceSecretList, type WorkspaceSecretMutation } from "@/lib/contracts/workspaceSecrets";

/**
 * The calls a resource change card makes, all through the Studio routes the
 * user's own session authorizes. Assistants use `components/assistants/assistantsApi.ts`
 * and Skill deletion the library store, so their Studio views stay current.
 */

/** A failed card request: the server's stable code when it sent one. */
export class ResourceChangeApiError extends Error {
  constructor(readonly code: string | null, readonly status: number) {
    super(code ?? `resource_change_http_${status}`);
    this.name = "ResourceChangeApiError";
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ResourceChangeApiError(record(body) && typeof body.error === "string" ? body.error : null, response.status);
  return body;
}

/** Whether the user's secret still has the revision a card names. */
export type SecretState = "current" | "changed" | "missing";

export async function readSecretState(secretId: string, versionId: string, signal?: AbortSignal): Promise<SecretState> {
  const body = await request("/api/me/workspace/secrets", { signal });
  const secrets = decodeWorkspaceSecretList(record(body) ? body.secrets : null);
  if (!secrets) throw new ResourceChangeApiError(null, 200);
  const secret = secrets.find((entry) => entry.id === secretId);
  return !secret ? "missing" : secret.versionId === versionId ? "current" : "changed";
}

/** Deletes the secret only while it still has that revision; otherwise the route answers `workspace_secret_conflict`. */
export async function deleteSecretVersion(secretId: string, versionId: string): Promise<void> {
  const mutation: WorkspaceSecretMutation = { action: "delete", expectedVersionId: versionId, id: secretId };
  await request("/api/me/workspace/secrets", { body: JSON.stringify(mutation), headers: { "content-type": "application/json" }, method: "POST" });
}

/** Whether the user's proxy still has the version a card names. */
export async function readProxyState(proxyId: string, proxyVersion: number, signal?: AbortSignal): Promise<SecretState> {
  const body = await request(PROXY_ROUTES.personal, { signal });
  if (!record(body) || !Array.isArray(body.proxies)) throw new ResourceChangeApiError(null, 200);
  const proxy = body.proxies.find((entry: unknown) => record(entry) && entry.id === proxyId) as Record<string, unknown> | undefined;
  return !proxy ? "missing" : proxy.version === proxyVersion ? "current" : "changed";
}

/** Deletes the proxy only while it still has that version; otherwise the route answers `proxy_conflict`, or `proxy_not_found` once it is gone. */
export async function deleteProxyVersion(proxyId: string, proxyVersion: number): Promise<void> {
  const guard: ProxyDeleteInput = { expectedVersion: proxyVersion };
  await request(PROXY_ROUTES.personalItem(proxyId), { body: JSON.stringify(guard), headers: { "content-type": "application/json" }, method: "DELETE" });
}
