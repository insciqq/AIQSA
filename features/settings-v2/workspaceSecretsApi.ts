import {
  decodeWorkspaceSecretList, workspaceSecretErrorMessage,
  type WorkspaceSecretMutation, type WorkspaceSecretSummary
} from "@/lib/contracts/workspaceSecrets";

export async function requestWorkspaceSecrets(mutation?: WorkspaceSecretMutation, signal?: AbortSignal): Promise<readonly WorkspaceSecretSummary[]> {
  const response = await fetch("/api/me/workspace/secrets", {
    method: mutation ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(mutation ? { headers: { "content-type": "application/json" }, body: JSON.stringify(mutation) } : {})
  });
  const body: unknown = await response.json().catch(() => null);
  const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!response.ok) throw new Error(workspaceSecretErrorMessage(data?.error));
  const secrets = decodeWorkspaceSecretList(data?.secrets);
  if (!secrets) throw new Error(workspaceSecretErrorMessage(null));
  return secrets;
}
