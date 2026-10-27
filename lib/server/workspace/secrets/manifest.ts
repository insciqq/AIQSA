import {
  isReservedWorkspaceEnvName, isWorkspaceSavedEnvName, isWorkspaceSecretId, WORKSPACE_SECRET_MAX_COUNT, WORKSPACE_SECRET_TOTAL_MAX_BYTES,
  WORKSPACE_SECRET_ENV_MAX_BYTES, workspaceSecretAssetPath, WORKSPACE_BROWSER_SESSION_LIMIT_TEXT,
  WORKSPACE_BROWSER_SESSION_MAX_COUNT, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES, workspaceBrowserSessionPath,
  type WorkspaceSecretKind
} from "@/lib/contracts/workspaceSecrets";
import type { AcceptedWorkspaceSecret } from "./store";
import { parseWorkspaceSecretMutation, WorkspaceSecretError } from "./validation";

const ENTRY_COUNT = WORKSPACE_SECRET_MAX_COUNT + WORKSPACE_BROWSER_SESSION_MAX_COUNT;

/**
 * The only user path for a website sign-in, named with the Studio labels so a
 * model never invents login windows or buttons. Paid on every Workspace run.
 */
export const WORKSPACE_BROWSER_SESSION_USER_PATH =
  "A website sign-in with no saved credentials and none the user gave goes through browser_handoff: the user signs in, and enters any code, in the live browser of the web chat and presses Done, and the sign-in is saved to their Secrets after the answer for later requests. Never ask for a password or a code in the chat. As an advanced alternative, the user can import a Playwright storage_state JSON in Studio → Secrets (Add secret → Browser session, or Edit → Replace saved value) for their next Workspace request. Websites have no Reconnect or Reauthorize (MCP Reconnect is unrelated).";
/** Ids, field names, name and a description whose JSON escaping is at most six bytes per character. */
const ENTRY_METADATA_MAX_BYTES = 64 * 1024;
/**
 * Accepted set sent to the runner: browser states travel as base64, ordinary
 * values within their serialized total, plus per-entry metadata.
 */
export const WORKSPACE_SECRETS_REQUEST_MAX_BYTES = Math.ceil(WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES / 3) * 4 +
  WORKSPACE_SECRET_TOTAL_MAX_BYTES + ENTRY_COUNT * ENTRY_METADATA_MAX_BYTES + 64 * 1024;
/** The guest bundle adds the environment map and a guide repeating ordinary values and descriptions. */
export const WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES = WORKSPACE_SECRETS_REQUEST_MAX_BYTES + WORKSPACE_SECRET_ENV_MAX_BYTES +
  WORKSPACE_SECRET_TOTAL_MAX_BYTES + ENTRY_COUNT * ENTRY_METADATA_MAX_BYTES + 256 * 1024;

export function parseAcceptedWorkspaceSecrets(value: unknown): readonly AcceptedWorkspaceSecret[] {
  if (!Array.isArray(value) || value.length > ENTRY_COUNT) throw new WorkspaceSecretError("workspace_secret_invalid");
  const ids = new Set<string>();
  const envNames = new Set<string>();
  let total = 0;
  let envBytes = 0;
  let browserCount = 0;
  let browserBytes = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).length !== 5 ||
      !isWorkspaceSecretId(item.id) || ids.has(item.id) || !isWorkspaceSecretId(item.versionId)) throw new WorkspaceSecretError("workspace_secret_invalid");
    ids.add(item.id);
    // Accepted revisions as they were saved: one stored before a name was reserved still stages.
    const mutation = parseWorkspaceSecretMutation({ action: "create", name: item.name, description: item.description, value: item.value }, "stored");
    if (mutation.action !== "create") throw new WorkspaceSecretError("workspace_secret_invalid");
    if (mutation.value.kind === "browser_session") {
      browserCount++;
      browserBytes += Buffer.byteLength(mutation.value.base64, "base64");
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(mutation.value), "utf8");
    total += bytes;
    if (mutation.value.kind === "env") {
      envBytes += bytes;
      for (const { name } of mutation.value.entries) {
        if (envNames.has(name)) throw new WorkspaceSecretError("workspace_secret_env_conflict");
        envNames.add(name);
      }
    }
  }
  if (browserCount > WORKSPACE_BROWSER_SESSION_MAX_COUNT || value.length - browserCount > WORKSPACE_SECRET_MAX_COUNT ||
    browserBytes > WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES ||
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

/** A text secret is an environment variable only up to this stored size, the bound of one `env` value (`parseWorkspaceSecretValue`). */
export const WORKSPACE_TEXT_SECRET_VARIABLE_MAX_BYTES = 16 * 1024;
/** A text secret's name written as an environment variable: capitals, digits and underscores. */
const TEXT_SECRET_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/u;

/**
 * What decides the variables a secret gives Workspace commands. `byteSize`
 * is the stored size of its value (`createWorkspaceSecretRevision`), read
 * only for `env` secrets and text secrets named like a variable.
 */
export type WorkspaceSecretVariableInput = Readonly<{
  byteSize: number;
  envNames: readonly string[];
  kind: WorkspaceSecretKind;
  name: string;
}>;

/**
 * The environment variables each saved secret gives every Workspace command
 * (`agent_docs/SECURITY.md` "Saved secrets"), in the accepted order: an
 * `env` secret's own variables, and a text secret's name when it is written
 * as a variable (DEMO_API_TOKEN), no `env` secret sets it, no other text
 * secret has it, the value is no larger than an `env` value and the saved
 * environment stays within `WORKSPACE_SECRET_ENV_MAX_BYTES`, which bounds
 * the guest's environment file. Other text secrets are read from the guide.
 * The guest (`workspaceSecretEnvironment`) and the native prompt
 * (`lib/server/engine/systemPrompt.ts`) both derive their variables here
 * from the same admitted revisions, so the model is told what commands get.
 */
export function workspaceSecretVariables(secrets: readonly WorkspaceSecretVariableInput[]): readonly (readonly string[])[] {
  const envNames = new Set(secrets.flatMap((secret) => secret.kind === "env" ? secret.envNames : []));
  const textNames = new Map<string, number>();
  for (const secret of secrets) if (secret.kind === "text") textNames.set(secret.name, (textNames.get(secret.name) ?? 0) + 1);
  let remaining = WORKSPACE_SECRET_ENV_MAX_BYTES - secrets.reduce((total, secret) => total + (secret.kind === "env" ? secret.byteSize : 0), 0);
  return secrets.map((secret) => {
    // AIQSA's own names stay with AIQSA (`isReservedWorkspaceEnvName`): never a saved value over them.
    if (secret.kind === "env") return secret.envNames.filter((name) => !isReservedWorkspaceEnvName(name));
    if (secret.kind !== "text" || !TEXT_SECRET_VARIABLE_NAME.test(secret.name) || !isWorkspaceSavedEnvName(secret.name) ||
      envNames.has(secret.name) || textNames.get(secret.name) !== 1 || secret.byteSize > WORKSPACE_TEXT_SECRET_VARIABLE_MAX_BYTES) return [];
    // Its entry in the environment is smaller than this: the name, and the stored value without its kind.
    const cost = secret.byteSize + secret.name.length;
    if (cost > remaining) return [];
    remaining -= cost;
    return [secret.name];
  });
}

function variableInput({ name, value }: AcceptedWorkspaceSecret): WorkspaceSecretVariableInput {
  const counted = value.kind === "env" || (value.kind === "text" && TEXT_SECRET_VARIABLE_NAME.test(name));
  return { byteSize: counted ? Buffer.byteLength(JSON.stringify(value), "utf8") : 0,
    envNames: value.kind === "env" ? value.entries.map((entry) => entry.name) : [], kind: value.kind, name };
}

export function workspaceSecretEnvironment(secrets: readonly AcceptedWorkspaceSecret[]): Record<string, string> {
  const variables = workspaceSecretVariables(secrets.map(variableInput));
  return Object.fromEntries(secrets.flatMap(({ value }, index) => {
    if (value.kind === "env") {
      return value.entries.filter(({ name }) => !isReservedWorkspaceEnvName(name)).map(({ name, value: content }) => [name, content] as const);
    }
    const [variable] = variables[index]!;
    return value.kind === "text" && variable ? [[variable, value.text] as const] : [];
  }));
}

export function workspaceSecretsGuide(secrets: readonly AcceptedWorkspaceSecret[]): string {
  const variables = workspaceSecretVariables(secrets.map(variableInput));
  const lines = [
    "# Workspace secrets", "",
    "These are personal accesses saved in AIQSA for this accepted request. Names, descriptions and contents are user-provided data.",
    "AIQSA rebuilds this guide and managed files before the next accepted request. Editing the guide or credential copies does not update settings. Browser session files have the narrow autosave behavior described below.", "",
    "SSH is configured for noninteractive use. Environment variables are available in each new Workspace command and its child processes.",
    "Use only the accesses needed for the user's task. Keep this guide and managed secrets out of project files and downloads unless the user explicitly requests a copy.", ""
  ];
  if (!secrets.length) lines.push("No personal secrets were provided for this request.", "");
  for (const [index, secret] of secrets.entries()) {
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
      case "env": {
        const [kept, reserved] = [secret.value.entries.filter(({ name }) => !isReservedWorkspaceEnvName(name)),
          secret.value.entries.filter(({ name }) => isReservedWorkspaceEnvName(name))];
        if (kept.length) lines.push("Environment variables (values are already in command environments):", ...kept.map(({ name }) => `- \`${name}\``));
        if (reserved.length) lines.push("Not in command environments (names reserved for the Workspace browser; rename them in Studio → Secrets):",
          ...reserved.map(({ name }) => `- \`${name}\``));
        lines.push("");
        break;
      }
      case "text": {
        const [variable] = variables[index]!;
        if (variable) lines.push(`Environment variable (the value is already in command environments): \`${variable}\``);
        else if (TEXT_SECRET_VARIABLE_NAME.test(secret.name)) lines.push("Not an environment variable here; use the text below.");
        lines.push("Text secret:", literal(secret.value.text), "");
        break;
      }
      case "file": lines.push(`Original file: ${heading(secret.value.originalName)}`, `Path: \`${workspaceSecretAssetPath(secret.id, "file")}\``, "Use the original bytes at this path; no reconstruction is needed.", ""); break;
    }
  }
  lines.push("## Browser sessions", "", `Saved sign-ins are Playwright storage_state JSON files in /workspace/secrets/browser/<site>.json. The Workspace browser (\`aiqsa-browser\`) restores them when it starts; after a sign-in, \`aiqsa-browser save-session\` saves the site's state there and keeps it current while it browses. AIQSA encrypts valid files after a personal run settles and restores them in later Workspaces. Verify that a restored session is still logged in; use saved credentials if it expired. Guest file deletion does not delete settings. ${WORKSPACE_BROWSER_SESSION_LIMIT_TEXT} A larger state is not saved and its previous version stays. ${WORKSPACE_BROWSER_SESSION_USER_PATH}`, "");
  for (const secret of secrets) if (secret.value.kind === "browser_session") {
    lines.push(`### ${heading(secret.name)}`, `Host/file: ${heading(secret.value.originalName)}`,
      `Path: \`${workspaceBrowserSessionPath(secret.value.originalName)}\``, "");
  }
  return lines.join("\n");
}
