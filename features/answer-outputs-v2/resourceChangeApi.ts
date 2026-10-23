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
