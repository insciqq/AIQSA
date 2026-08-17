import type {
  AdminMcpServer,
  McpConfigurationSlot,
  McpDraftConfiguration,
  McpSlotValue,
  McpSource,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";

export type NormalizedMcpImport = Readonly<{
  description: string;
  draft: McpDraftConfiguration;
  name: string;
  sharedValues: Record<string, McpSlotValue>;
}>;

export type AdminMcpSharedValueDraft = Record<string, McpSlotValue | null | undefined>;

export type AdminMcpServerForm = {
  description: string;
  draft: McpDraftConfiguration;
  name: string;
  sharedValues: AdminMcpSharedValueDraft;
};

export type McpToolInventoryDiff = Readonly<{
  added: McpToolInventoryEntry[];
  changed: McpToolInventoryEntry[];
  removed: McpToolInventoryEntry[];
  unchanged: McpToolInventoryEntry[];
}>;

type RemoteMcpSource = Extract<McpSource, { kind: "remote" }>;
type McpOAuthAuthPolicy = Extract<McpDraftConfiguration["auth"], { mode: "oauth" }>;

const HOSTED_NOTION_MCP_ORIGIN = "https://mcp.notion.com";
const HOSTED_NOTION_MCP_PATH = "/mcp";

function remoteSourceOrigin(source: RemoteMcpSource): string | null {
  try {
    const url = new URL(source.url);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function isHostedNotionMcp(source: RemoteMcpSource): boolean {
  try {
    const url = new URL(source.url);
    return url.origin === HOSTED_NOTION_MCP_ORIGIN &&
      url.pathname.replace(/\/+$/u, "") === HOSTED_NOTION_MCP_PATH &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

export function preparedMcpOAuthPolicy(
  source: RemoteMcpSource,
  current?: McpOAuthAuthPolicy
): McpOAuthAuthPolicy {
  const sourceOrigin = remoteSourceOrigin(source);
  return {
    ...(current ?? {}),
    allowedAuthorizationServerOrigins: current?.allowedAuthorizationServerOrigins.length
      ? current.allowedAuthorizationServerOrigins
      : sourceOrigin ? [sourceOrigin] : [],
    mode: "oauth",
    scopes: current?.scopes ?? []
  };
}

export function changeMcpRemoteSource(
  draft: McpDraftConfiguration,
  source: RemoteMcpSource
): McpDraftConfiguration {
  if (draft.source.kind !== "remote" || draft.auth.mode !== "oauth") {
    return { ...draft, source };
  }
  const previousOrigin = remoteSourceOrigin(draft.source);
  const origins = draft.auth.allowedAuthorizationServerOrigins;
  const sourceOwnedOrigins = origins.length === 0 ||
    (origins.length === 1 && origins[0] === previousOrigin);
  return {
    ...draft,
    auth: sourceOwnedOrigins
      ? preparedMcpOAuthPolicy(source, {
          ...draft.auth,
          allowedAuthorizationServerOrigins: []
        })
      : draft.auth,
    source
  };
}

export function defaultMcpDraft(kind: McpSource["kind"] = "remote"): McpDraftConfiguration {
  const source: McpSource = kind === "remote"
    ? { kind: "remote", url: "" }
    : kind === "npm"
      ? { args: [], kind: "npm", packageName: "" }
      : kind === "pypi"
        ? { args: [], kind: "pypi", packageName: "" }
        : { args: [], image: "", kind: "oci" };

  return {
    auth: { mode: "none" },
    runtime: {
      callTimeoutMs: 60_000,
      startupTimeoutMs: 60_000
    },
    slots: [],
    source,
    transport: kind === "remote" ? "streamable_http" : "stdio"
  };
}

export function blankMcpServerForm(): AdminMcpServerForm {
  return {
    description: "",
    draft: defaultMcpDraft(),
    name: "",
    sharedValues: {}
  };
}

export function editableMcpServerForm(server: AdminMcpServer): AdminMcpServerForm {
  const draft = structuredClone(server.draft);
  if (draft.source.kind === "remote" && draft.auth.mode === "oauth" &&
    draft.auth.allowedAuthorizationServerOrigins.length === 0) {
    draft.auth = preparedMcpOAuthPolicy(draft.source, draft.auth);
  }
  return {
    description: server.description,
    draft,
    name: server.name,
    sharedValues: {}
  };
}

export function requestMcpSharedValues(
  form: AdminMcpServerForm
): Record<string, McpSlotValue | null> | undefined {
  const currentKeys = new Set(form.draft.slots.map((slot) => slot.slotKey));
  const entries = Object.entries(form.sharedValues).filter(
    (entry): entry is [string, McpSlotValue | null] => currentKeys.has(entry[0]) && entry[1] !== undefined
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function changeMcpSourceKind(
  draft: McpDraftConfiguration,
  kind: McpSource["kind"]
): McpDraftConfiguration {
  const next = defaultMcpDraft(kind);
  const targetKind = kind === "remote" ? "header" : "environment";

  return {
    ...draft,
    auth: kind === "remote" ? draft.auth : { mode: draft.auth.mode === "static" ? "static" : "none" },
    slots: draft.slots.map((slot) => ({
      ...slot,
      target: {
        kind: targetKind,
        name: slot.target.name
      }
    })),
    source: next.source,
    transport: next.transport
  };
}

export function splitMcpArguments(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function joinMcpArguments(value: readonly string[]): string {
  return value.join("\n");
}

export function splitMcpList(value: string): string[] {
  return value
    .split(/[\r\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sourceDisplay(source: McpSource): string {
  if (source.kind === "remote") return source.url || "Remote endpoint not set";
  if (source.kind === "oci") return source.image || "OCI digest not set";
  return `${source.packageName || `${source.kind.toUpperCase()} package not set`}${
    source.versionSelector ? ` @ ${source.versionSelector}` : ""
  }`;
}

export function draftInventory(server: AdminMcpServer): McpToolInventoryEntry[] {
  return server.draftTest?.toolInventory ?? [];
}

export function activeInventory(server: AdminMcpServer): McpToolInventoryEntry[] {
  return server.activeRevision?.validationEvidence.toolInventory ?? [];
}

export function enabledMcpToolInventory(
  tools: readonly McpToolInventoryEntry[],
  disabledToolNames: readonly string[] | undefined
): McpToolInventoryEntry[] {
  const disabled = new Set(disabledToolNames ?? []);
  return tools.filter((tool) => !disabled.has(tool.name));
}

export function staleDisabledMcpToolNames(
  draft: McpDraftConfiguration,
  tools: readonly McpToolInventoryEntry[]
): string[] {
  const advertised = new Set(tools.map((tool) => tool.name));
  return (draft.disabledToolNames ?? []).filter((name) => !advertised.has(name));
}

export function withMcpToolEnabled(
  draft: McpDraftConfiguration,
  name: string,
  enabled: boolean
): McpDraftConfiguration {
  const disabled = new Set(draft.disabledToolNames ?? []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const { disabledToolNames: _disabledToolNames, ...definition } = draft;
  const disabledToolNames = [...disabled].sort();
  return disabledToolNames.length ? { ...definition, disabledToolNames } : definition;
}

export function diffMcpToolInventory(
  active: readonly McpToolInventoryEntry[],
  candidate: readonly McpToolInventoryEntry[]
): McpToolInventoryDiff {
  const activeByName = new Map(active.map((tool) => [tool.name, tool]));
  const candidateByName = new Map(candidate.map((tool) => [tool.name, tool]));
  const added: McpToolInventoryEntry[] = [];
  const changed: McpToolInventoryEntry[] = [];
  const removed: McpToolInventoryEntry[] = [];
  const unchanged: McpToolInventoryEntry[] = [];

  for (const tool of candidate) {
    const previous = activeByName.get(tool.name);
    if (!previous) {
      added.push(tool);
    } else if (previous.description !== tool.description) {
      changed.push(tool);
    } else {
      unchanged.push(tool);
    }
  }
  for (const tool of active) {
    if (!candidateByName.has(tool.name)) removed.push(tool);
  }

  return { added, changed, removed, unchanged };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function slotKeyFor(name: string, used: Set<string>): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "_")
    .replace(/^[^a-z]+/u, "") || "value";
  let candidate = base.slice(0, 120);
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 115)}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function sharedSlots(
  values: Record<string, string>,
  targetKind: "environment" | "header"
): { sharedValues: Record<string, string>; slots: McpConfigurationSlot[] } {
  const used = new Set<string>();
  const sharedValues: Record<string, string> = {};
  const slots = Object.entries(values).map(([name, value]) => {
    const slotKey = slotKeyFor(name, used);
    sharedValues[slotKey] = value;
    return {
      label: name,
      policy: { allowPersonalOverride: false, kind: "shared" } as const,
      sensitive: true,
      slotKey,
      target: { kind: targetKind, name } as const,
      valueType: "secret" as const
    };
  });
  return { sharedValues, slots };
}

function splitNpmPackage(value: string): { packageName: string; versionSelector?: string } {
  const lastAt = value.lastIndexOf("@");
  if (lastAt > 0) {
    return {
      packageName: value.slice(0, lastAt),
      versionSelector: value.slice(lastAt + 1)
    };
  }
  return { packageName: value };
}

function splitPythonPackage(value: string): { packageName: string; versionSelector?: string } {
  const separator = value.indexOf("==");
  if (separator > 0) {
    return {
      packageName: value.slice(0, separator),
      versionSelector: `==${value.slice(separator + 2)}`
    };
  }
  return { packageName: value };
}

function commandName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().split(/[\\/]/u).at(-1)?.replace(/\.cmd$/iu, "").toLowerCase() ?? "";
}

function commandArgs(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function pipInstallSource(command: string, rawArgs: string[]): McpSource | null {
  const pythonPip = command === "python" || /^python\d+(?:\.\d+)?$/u.test(command);
  const args = pythonPip && rawArgs[0] === "-m" && commandName(rawArgs[1]) === "pip"
    ? rawArgs.slice(2)
    : /^pip\d*(?:\.\d+)?$/u.test(command)
      ? rawArgs
      : null;
  if (!args) return null;
  if (args[0] !== "install") {
    throw new Error("Paste a pip install command, for example: pip install canvas-local-mcp.");
  }
  const ignoredFlags = new Set(["--no-cache-dir", "--upgrade", "--user", "-U"]);
  const packages = args.slice(1).filter((entry) => !ignoredFlags.has(entry));
  if (packages.length !== 1 || packages[0]!.startsWith("-") || /^(?:https?:|git\+|\.|\/)/iu.test(packages[0]!)) {
    throw new Error("The pip import must install exactly one package from PyPI.");
  }
  return { args: [], kind: "pypi", ...splitPythonPackage(packages[0]!) };
}

function normalizeCommandSource(command: string, rawArgs: string[]): McpSource {
  const pipSource = pipInstallSource(command, rawArgs);
  if (pipSource) return pipSource;
  if (command === "npx") {
    const index = rawArgs.findIndex((entry) => !entry.startsWith("-") && entry !== "yes");
    if (index < 0) throw new Error("The npx config does not name a package.");
    const selected = splitNpmPackage(rawArgs[index]!);
    return { args: rawArgs.slice(index + 1), kind: "npm", ...selected };
  }
  if (command === "uvx" || command === "pipx") {
    const normalized = rawArgs.filter((entry) => entry !== "run");
    const index = normalized.findIndex((entry) => !entry.startsWith("-"));
    if (index < 0) throw new Error(`The ${command} config does not name a package.`);
    const selected = splitPythonPackage(normalized[index]!);
    return { args: normalized.slice(index + 1), kind: "pypi", ...selected };
  }
  if (command === "docker" || command === "podman") {
    const flagsWithValues = new Set(["-e", "--env", "--name", "-p", "--publish", "-v", "--volume", "-w", "--workdir", "--network"]);
    let index = 0;
    while (index < rawArgs.length) {
      const entry = rawArgs[index]!;
      if (["run", "--rm", "-i", "--interactive"].includes(entry) || /^--(?:env|name|publish|volume|workdir|network)=/u.test(entry)) {
        index += 1;
        continue;
      }
      if (flagsWithValues.has(entry)) {
        index += 2;
        continue;
      }
      if (entry.startsWith("-")) {
        index += 1;
        continue;
      }
      return { args: rawArgs.slice(index + 1), image: entry, kind: "oci" };
    }
    throw new Error(`The ${command} config does not name an OCI image.`);
  }
  throw new Error(
    "AIQSA could not identify how that command is installed. Paste an npx, uvx, pipx, pip install, docker, or podman command, or configure the source manually."
  );
}

function splitPastedCommand(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const push = () => {
    if (!token) return;
    tokens.push(token);
    token = "";
  };

  for (const character of value) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    if (";&|<>`".includes(character)) {
      throw new Error("Paste one launch or install command without shell operators.");
    }
    token += character;
  }
  if (quote || escaping) throw new Error("The pasted command has an unfinished quote or escape.");
  push();
  if (!tokens.length) throw new Error("Paste an MCP URL, JSON configuration, or install command.");
  return tokens;
}

function normalizedCommandImport(text: string): NormalizedMcpImport {
  const [rawCommand, ...args] = splitPastedCommand(text);
  const source = normalizeCommandSource(commandName(rawCommand), args);
  const draft = defaultMcpDraft(source.kind);
  draft.source = source;
  return {
    description: "",
    draft,
    name: importedName("", source),
    sharedValues: {}
  };
}

function withoutJsonTrailingCommas(text: string): string {
  let inString = false;
  let escaping = false;
  let normalized = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      normalized += character;
      if (escaping) {
        escaping = false;
      } else if (character === "\\") {
        escaping = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }

    if (character === ",") {
      let nextIndex = index + 1;
      while (nextIndex < text.length && /\s/u.test(text[nextIndex]!)) nextIndex += 1;

      let previousIndex = index - 1;
      while (previousIndex >= 0 && /\s/u.test(text[previousIndex]!)) previousIndex -= 1;

      const next = text[nextIndex];
      const previous = text[previousIndex];
      const followsValue = previous !== undefined && !"{[,:".includes(previous);
      if (followsValue && (next === "}" || next === "]")) {
        normalized += " ";
        continue;
      }
    }

    normalized += character;
  }

  return normalized;
}

function parseMcpImportJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const normalized = withoutJsonTrailingCommas(text);
    if (normalized === text) throw strictError;
    return JSON.parse(normalized);
  }
}

function splitJsonWithSourceHint(text: string): Readonly<{
  decoded: unknown;
  sourceHint: McpSource;
}> | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "}") continue;
    const suffix = text.slice(index + 1).trim();
    if (!suffix) continue;
    let decoded: unknown;
    try {
      decoded = parseMcpImportJson(text.slice(0, index + 1));
    } catch {
      // A nested object may end before the complete JSON document. Keep looking.
      continue;
    }
    const [rawCommand, ...args] = splitPastedCommand(suffix);
    return {
      decoded,
      sourceHint: normalizeCommandSource(commandName(rawCommand), args)
    };
  }
  return null;
}

function isManagedSourceCommand(command: string): boolean {
  return command === "npx"
    || command === "uvx"
    || command === "pipx"
    || command === "docker"
    || command === "podman"
    || /^pip\d*(?:\.\d+)?$/u.test(command)
    || command === "python"
    || /^python\d+(?:\.\d+)?$/u.test(command);
}

function importedConfigSource(
  config: Record<string, unknown>,
  sourceHint: McpSource | null
): McpSource {
  const url = typeof config.url === "string"
    ? config.url
    : typeof config.endpoint === "string"
      ? config.endpoint
      : null;
  if (url) {
    if (sourceHint) throw new Error("A remote MCP URL does not need a local install command.");
    return {
      kind: "remote",
      url,
      ...(config.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {})
    };
  }

  const command = commandName(config.command);
  if (sourceHint && !isManagedSourceCommand(command)) {
    if (!command) throw new Error("The MCP JSON must include the local command it launches.");
    if (sourceHint.kind === "remote") throw new Error("A local MCP install command must resolve to a package or container source.");
    return { ...sourceHint, args: commandArgs(config.args) };
  }
  const source = normalizeCommandSource(command, commandArgs(config.args));
  if (sourceHint) {
    throw new Error("Paste either a self-installing MCP command or a bare-command JSON plus one install command, not both.");
  }
  return source;
}

function importedName(name: string, source: McpSource): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  if (source.kind === "remote") {
    try {
      return new URL(source.url).hostname;
    } catch {
      return "Remote MCP";
    }
  }
  if (source.kind === "oci") return source.image.split("/").at(-1)?.split("@")[0] || "OCI MCP";
  return source.packageName;
}

export function normalizeMcpImport(raw: string): NormalizedMcpImport {
  const text = raw.trim();
  if (!text) throw new Error("Paste an MCP URL, JSON configuration, or install command.");

  if (/^https?:\/\//iu.test(text)) {
    const draft = defaultMcpDraft("remote");
    draft.source = { kind: "remote", url: text };
    if (isHostedNotionMcp(draft.source)) {
      draft.auth = preparedMcpOAuthPolicy(draft.source);
    }
    return { description: "", draft, name: importedName("", draft.source), sharedValues: {} };
  }

  let decoded: unknown;
  let sourceHint: McpSource | null = null;
  try {
    decoded = parseMcpImportJson(text);
  } catch {
    const combined = splitJsonWithSourceHint(text);
    if (!combined) {
      if (text.startsWith("{") || text.startsWith("[")) {
        throw new Error("The MCP configuration is not valid JSON. Trailing commas are accepted; check quotes, commas, and brackets.");
      }
      return normalizedCommandImport(text);
    }
    decoded = combined.decoded;
    sourceHint = combined.sourceHint;
  }
  if (!isRecord(decoded)) throw new Error("The MCP configuration must be a JSON object.");

  let name = typeof decoded.name === "string" ? decoded.name : "";
  let config: Record<string, unknown> = decoded;
  if (isRecord(decoded.mcpServers)) {
    const entries = Object.entries(decoded.mcpServers);
    if (entries.length !== 1 || !isRecord(entries[0]?.[1])) {
      throw new Error("Paste exactly one entry from mcpServers at a time.");
    }
    name = entries[0]![0];
    config = entries[0]![1] as Record<string, unknown>;
  }

  const source = importedConfigSource(config, sourceHint);
  const boundValues = source.kind === "remote"
    ? sharedSlots(stringRecord(config.headers), "header")
    : sharedSlots(stringRecord(config.env), "environment");
  const draft = defaultMcpDraft(source.kind);
  draft.source = source;
  draft.slots = boundValues.slots;
  if (source.kind === "remote" && (config.auth === "oauth" || isHostedNotionMcp(source))) {
    draft.auth = preparedMcpOAuthPolicy(source);
  } else if (boundValues.slots.length) {
    draft.auth = { mode: "static" };
  }

  return {
    description: typeof config.description === "string" ? config.description : "",
    draft,
    name: importedName(name, source),
    sharedValues: boundValues.sharedValues
  };
}
