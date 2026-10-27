import {
  decodeWorkspaceBrowserAutosaveReport, decodeWorkspaceSecretList, decodeWorkspaceSecretReveal, workspaceSecretErrorMessage,
  type WorkspaceBrowserAutosaveReport, type WorkspaceSecretMutation, type WorkspaceSecretReveal, type WorkspaceSecretRevealRequest,
  type WorkspaceSecretSummary
} from "@/lib/contracts/workspaceSecrets";

export type WorkspaceSecretsState = Readonly<{
  secrets: readonly WorkspaceSecretSummary[];
  browserAutosave: WorkspaceBrowserAutosaveReport | null;
}>;

async function send(body: WorkspaceSecretMutation | WorkspaceSecretRevealRequest | undefined, signal?: AbortSignal) {
  const response = await fetch("/api/me/workspace/secrets", {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  });
  const parsed: unknown = await response.json().catch(() => null);
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  return { response, data };
}

export async function requestWorkspaceSecrets(mutation?: WorkspaceSecretMutation, signal?: AbortSignal): Promise<WorkspaceSecretsState> {
  const { response, data } = await send(mutation, signal);
  if (!response.ok) throw new Error(workspaceSecretErrorMessage(data?.error));
  const secrets = decodeWorkspaceSecretList(data?.secrets);
  if (!secrets) throw new Error(workspaceSecretErrorMessage(null));
  return { secrets, browserAutosave: decodeWorkspaceBrowserAutosaveReport(data?.browserAutosave) };
}

/** The owner's saved value for Studio › Secrets: held only in component state, never in browser storage. */
export async function revealWorkspaceSecret(id: string, signal?: AbortSignal): Promise<WorkspaceSecretReveal> {
  const { response, data } = await send({ action: "reveal", id }, signal);
  const code = data?.error;
  if (!response.ok) {
    throw new Error(code === "workspace_secret_not_found" || code === "workspace_secret_not_revealable"
      ? workspaceSecretErrorMessage(code) : "The values could not be shown. Try again.");
  }
  const revealed = decodeWorkspaceSecretReveal(data, id);
  if (!revealed) throw new Error("The values could not be shown. Try again.");
  return revealed;
}
