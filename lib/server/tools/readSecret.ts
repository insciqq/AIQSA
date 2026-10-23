import { workspaceBrowserSessionPath, workspaceSecretAssetPath } from "@/lib/contracts/workspaceSecrets";
import type { RunSecretEntry, RunSecretSource } from "../workspace/secrets/runSecrets";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { harnessToolError, type HarnessToolDescriptor } from "./harnessTool";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionContext, type ToolExecutionResult } from "./types";

/**
 * `read_secret`: the value of one of the user's saved secrets, in any chat and
 * without the Workspace VM (operator decision 2026-10-22,
 * `agent_docs/SECURITY.md` "Saved secrets"). Values reach the provider and the
 * transcript as the accepted risk says; nothing here logs them.
 */

export const READ_SECRET_TOOL_NAME = "read_secret";

export const READ_SECRET_LIMITS = Object.freeze({
  nameCharacters: 256,
  /** Binary file secrets up to this size are returned as base64; larger ones only by Workspace path. */
  binaryFileBytes: 64 * 1_024,
  /** Names listed in a refusal. */
  listedNames: 50
});

const DESCRIPTION = `Returns the value of one of the user's saved secrets (Studio → Secrets) by name. Works in every chat and does not start the Workspace.
name: the secret's name, or the name of an environment variable inside an environment-variable secret. Matching is exact first, then case-insensitive when that is unambiguous.
Result by kind: env (all variables, or the one variable named), text (the text), ssh_key (private key, passphrase and its Workspace path), file (UTF-8 text, base64 for small binary files, and its Workspace path), browser_session (only its host and Workspace path; the Workspace browser uses it).
An unknown name is refused with the list of available names. A value you read is stored in this chat's history and sent to the model provider; use it only for the user's task and do not repeat it in your answer unless the user asks. In Workspace commands the same values are already set as environment variables and files (/workspace/SECRETS.md).`;

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    name: { description: "Secret name or environment variable name.", type: "string" }
  },
  required: ["name"],
  type: "object"
};

export const readSecretTool: HarnessToolDescriptor = Object.freeze({
  description: DESCRIPTION,
  effects: "none",
  inputSchema: INPUT_SCHEMA,
  name: READ_SECRET_TOOL_NAME,
  needsApproval: false,
  requiresVm: false,
  tool: Object.freeze({ capability: "session", description: DESCRIPTION, inputSchema: INPUT_SCHEMA, name: READ_SECRET_TOOL_NAME, strict: true })
});

type Match = Readonly<{ entry: RunSecretEntry; variable?: string }>;

function matches(entries: readonly RunSecretEntry[], name: string): readonly Match[] {
  const exact = [...entries.filter((entry) => entry.name === name).map((entry) => ({ entry })),
    ...entries.flatMap((entry) => entry.envNames.includes(name) ? [{ entry, variable: name }] : [])];
  if (exact.length) return exact;
  const folded = name.toLocaleLowerCase("en-US");
  return [...entries.filter((entry) => entry.name.toLocaleLowerCase("en-US") === folded).map((entry) => ({ entry })),
    ...entries.flatMap((entry) => entry.envNames.filter((variable) => variable.toLocaleLowerCase("en-US") === folded)
      .map((variable) => ({ entry, variable })))];
}

function describe(entry: RunSecretEntry): string {
  return `${JSON.stringify(entry.name)} (${entry.kind}${entry.envNames.length ? `: ${entry.envNames.join(", ")}` : ""})`;
}

function availableNames(entries: readonly RunSecretEntry[]): string {
  const shown = entries.slice(0, READ_SECRET_LIMITS.listedNames).map(describe);
  const more = entries.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

function utf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** What the model receives for one secret, by kind. */
function projection(secret: AcceptedWorkspaceSecret, variable: string | undefined): Record<string, unknown> {
  const base = { ...(secret.description ? { description: secret.description } : {}), kind: secret.value.kind, name: secret.name };
  switch (secret.value.kind) {
    case "env": {
      if (!variable) return { ...base, values: Object.fromEntries(secret.value.entries.map((item) => [item.name, item.value])) };
      const match = secret.value.entries.find((item) => item.name === variable);
      if (!match) throw new Error("read_secret_variable_missing");
      return { ...base, value: match.value, variable };
    }
    case "text":
      return { ...base, value: secret.value.text };
    case "ssh_key":
      return { ...base, privateKey: secret.value.privateKey, ...(secret.value.passphrase ? { passphrase: secret.value.passphrase } : {}),
        workspacePath: workspaceSecretAssetPath(secret.id, "ssh_key") };
    case "file": {
      const bytes = Buffer.from(secret.value.base64, "base64");
      const text = utf8(bytes);
      return { ...base, originalName: secret.value.originalName, workspacePath: workspaceSecretAssetPath(secret.id, "file"),
        ...(text !== null ? { encoding: "utf8", value: text }
          : bytes.byteLength <= READ_SECRET_LIMITS.binaryFileBytes ? { encoding: "base64", value: secret.value.base64 }
            : { note: `A binary file of ${bytes.byteLength} bytes; use it from the Workspace path.` }) };
    }
    case "browser_session":
      return { ...base, host: secret.value.originalName, note: "A saved website sign-in for the Workspace browser; its cookies are not returned here.",
        workspacePath: workspaceBrowserSessionPath(secret.value.originalName) };
  }
}

/** Reads one secret of the run's readable set. Refusals list what is available. */
export async function executeReadSecret(source: RunSecretSource, call: ModelToolCall,
  context: Pick<ToolExecutionContext, "runId" | "userId">, options: { signal?: AbortSignal } = {}): Promise<ToolExecutionResult> {
  const { signal } = options;
  if (hasInvalidProviderToolArguments(call.arguments)) {
    return harnessToolError(call, "read_secret_invalid", "The arguments were not valid JSON. Pass {\"name\": \"<secret name>\"}.");
  }
  const name = call.arguments.name;
  if (typeof name !== "string" || !name.trim() || name.length > READ_SECRET_LIMITS.nameCharacters) {
    return harnessToolError(call, "read_secret_invalid", `Pass the secret's name as \`name\`, a non-empty string of at most ${READ_SECRET_LIMITS.nameCharacters} characters.`);
  }
  if (!context.runId || !context.userId) {
    return harnessToolError(call, "read_secret_unavailable", "Saved secrets are not available in this run.");
  }
  const scope = { runId: context.runId, userId: context.userId };
  try {
    signal?.throwIfAborted();
    const entries = await source.list(scope);
    if (!entries.length) {
      return harnessToolError(call, "read_secret_unknown", "The user has no saved secrets available in this chat. They can add one in Studio → Secrets; Project chats never receive personal secrets.", { available: [] });
    }
    let found = matches(entries, name.trim());
    if (!found.length) {
      return harnessToolError(call, "read_secret_unknown", `No saved secret or environment variable is named ${JSON.stringify(name)}. Available: ${availableNames(entries)}.`,
        { available: entries.slice(0, READ_SECRET_LIMITS.listedNames).map((entry) => entry.name) });
    }
    if (found.length > 1 && found.every((match) => match.entry.valueId === found[0]!.entry.valueId)) {
      // One secret whose name equals one of its own variables: the variable is the more specific reading.
      found = [found.find((match) => match.variable) ?? found[0]!];
    }
    if (found.length > 1) {
      return harnessToolError(call, "read_secret_ambiguous", `${JSON.stringify(name)} matches ${found.length} saved secrets: ${found.map((match) => describe(match.entry)).join("; ")}. Use the exact secret name.`);
    }
    const { entry, variable } = found[0]!;
    signal?.throwIfAborted();
    const secret = await source.read({ ...scope, valueId: entry.valueId });
    return { callId: call.id, content: [{ type: "json", value: projection(secret, variable) }], name: call.name, status: "complete" };
  } catch {
    if (signal?.aborted) throw signal.reason;
    // Content-free on purpose: neither a value nor the error text leaves here.
    return harnessToolError(call, "read_secret_unavailable", "Saved secrets could not be read right now. Try again once; if it fails again, tell the user.");
  }
}
