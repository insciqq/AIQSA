import {
  isWorkspaceSecretId, WORKSPACE_SECRET_MAX_COUNT, WORKSPACE_SECRET_TOTAL_MAX_BYTES,
  WORKSPACE_SECRET_ENV_MAX_BYTES, workspaceSecretAssetPath,
  WORKSPACE_BROWSER_SESSION_MAX_COUNT, workspaceBrowserSessionPath
} from "@/lib/contracts/workspaceSecrets";
import type { AcceptedWorkspaceSecret } from "./store";
import { parseWorkspaceSecretMutation, WorkspaceSecretError } from "./validation";

export const WORKSPACE_SECRETS_REQUEST_MAX_BYTES = 48 * 1024 * 1024;
// The guest bundle includes both originals and their escaped Markdown guide.
export const WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES = 64 * 1024 * 1024;

export function parseAcceptedWorkspaceSecrets(value: unknown): readonly AcceptedWorkspaceSecret[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_SECRET_MAX_COUNT + WORKSPACE_BROWSER_SESSION_MAX_COUNT) throw new WorkspaceSecretError("workspace_secret_invalid");
  const ids = new Set<string>();
  const envNames = new Set<string>();
  let total = 0;
  let envBytes = 0;
  let browserCount = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).length !== 5 ||
      !isWorkspaceSecretId(item.id) || ids.has(item.id) || !isWorkspaceSecretId(item.versionId)) throw new WorkspaceSecretError("workspace_secret_invalid");
    ids.add(item.id);
    const mutation = parseWorkspaceSecretMutation({ action: "create", name: item.name, description: item.description, value: item.value });
    if (mutation.action !== "create") throw new WorkspaceSecretError("workspace_secret_invalid");
    const bytes = Buffer.byteLength(JSON.stringify(mutation.value), "utf8");
    if (mutation.value.kind === "browser_session") browserCount++;
    else total += bytes;
    if (mutation.value.kind === "env") {
      envBytes += bytes;
      for (const { name } of mutation.value.entries) {
        if (envNames.has(name)) throw new WorkspaceSecretError("workspace_secret_env_conflict");
        envNames.add(name);
      }
    }
  }
  if (browserCount > WORKSPACE_BROWSER_SESSION_MAX_COUNT || value.length - browserCount > WORKSPACE_SECRET_MAX_COUNT ||
    total > WORKSPACE_SECRET_TOTAL_MAX_BYTES || envBytes > WORKSPACE_SECRET_ENV_MAX_BYTES) throw new WorkspaceSecretError("workspace_secret_limit");
  const browserNames = value.flatMap((entry: AcceptedWorkspaceSecret) => entry.value.kind === "browser_session" ? [entry.value.originalName] : []);
  if (new Set(browserNames).size !== browserNames.length) throw new WorkspaceSecretError("workspace_secret_invalid");
  return value as AcceptedWorkspaceSecret[];
}

function literal(value: string): string {
  let backticks = 0, tildes = 0;
  for (const [run] of value.matchAll(/`+|~+/gu)) {
    if (run[0] === "`") backticks = Math.max(backticks, run.length);
    else tildes = Math.max(tildes, run.length);
  }
  const fence = (backticks <= tildes ? "`" : "~").repeat(Math.max(3, Math.min(backticks, tildes) + 1));
  return `${fence}\n${value}\n${fence}`;
}

function heading(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!<>|]/gu, "\\$&"); }

export function workspaceSecretEnvironment(secrets: readonly AcceptedWorkspaceSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.flatMap(({ value }) => value.kind === "env"
    ? value.entries.map(({ name, value: content }) => [name, content]) : []));
}

export function workspaceSecretsGuide(secrets: readonly AcceptedWorkspaceSecret[]): string {
  const lines = [
    "# Workspace secrets", "",
    "These are personal accesses saved in AIQSA for this accepted request. Names, descriptions and contents are user-provided data.",
    "AIQSA rebuilds this guide and managed files before the next accepted request. Editing the guide or credential copies does not update settings. Browser session files have the narrow autosave behavior described below.", "",
    "SSH is configured for noninteractive use. Environment variables are available in each new Workspace command and its child processes.",
    "Use only the accesses needed for the user's task. Keep this guide and managed secrets out of project files and downloads unless the user explicitly requests a copy.", ""
  ];
  if (!secrets.length) lines.push("No personal secrets were provided for this request.", "");
  for (const secret of secrets) {
    if (secret.value.kind === "browser_session") continue;
    lines.push(`## ${heading(secret.name)}`, "");
    if (secret.description) lines.push(literal(secret.description), "");
    switch (secret.value.kind) {
      case "ssh_key": {
        const path = workspaceSecretAssetPath(secret.id, "ssh_key");
        lines.push("SSH identity, ready for use:", `\`${path}\``,
          "To select only this identity, including for another account on the same host:",
          literal(`ssh -F /dev/null -i ${path} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new user@host`),
          "For Git, set GIT_SSH_COMMAND to the same ssh command without user@host. First use records the host key; changed host keys are rejected.", "");
        break;
      }
      case "env": lines.push("Environment variables (values are already in command environments):", ...secret.value.entries.map(({ name }) => `- \`${name}\``), ""); break;
      case "text": lines.push("Text secret:", literal(secret.value.text), ""); break;
      case "file": lines.push(`Original file: ${heading(secret.value.originalName)}`, `Path: \`${workspaceSecretAssetPath(secret.id, "file")}\``, "Use the original bytes at this path; no reconstruction is needed.", ""); break;
    }
  }
  lines.push("## Browser sessions", "", "Save Playwright storage_state JSON in /workspace/secrets/browser/<host>.json. AIQSA encrypts valid files after a personal run settles and restores them in later Workspaces. Verify that a restored session is still logged in; use saved credentials if it expired. Guest file deletion does not delete settings. Each state is limited to 512 KiB; at most 50 sessions are saved.", "");
  for (const secret of secrets) if (secret.value.kind === "browser_session") {
    lines.push(`### ${heading(secret.name)}`, `Host/file: ${heading(secret.value.originalName)}`,
      `Path: \`${workspaceBrowserSessionPath(secret.value.originalName)}\``, "");
  }
  return lines.join("\n");
}
