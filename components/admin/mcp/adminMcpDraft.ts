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
  expectedUpdatedAt?: string;
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

type McpOAuthAuthPolicy = Extract<McpDraftConfiguration["auth"], { mode: "oauth" }>;

const HOSTED_NOTION_MCP_ORIGIN = "https://mcp.notion.com";
const HOSTED_NOTION_MCP_PATH = "/mcp";

function remoteSourceOrigin(source: McpSource): string | null {
  try {
    const url = new URL(source.url);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function isHostedNotionMcp(source: McpSource): boolean {
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
  source: McpSource,
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
  source: McpSource
): McpDraftConfiguration {
  if (draft.auth.mode !== "oauth") {
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

export function defaultMcpDraft(): McpDraftConfiguration {
  return {
    auth: { mode: "none" },
    runtime: {
      callTimeoutMs: 300_000,
      startupTimeoutMs: 60_000
    },
    slots: [],
    source: { kind: "remote", url: "" },
    transport: "streamable_http"
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
  if (draft.auth.mode === "oauth" &&
    draft.auth.allowedAuthorizationServerOrigins.length === 0) {
    draft.auth = preparedMcpOAuthPolicy(draft.source, draft.auth);
  }
  return {
    description: server.description,
    expectedUpdatedAt: server.updatedAt,
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

export function splitMcpList(value: string): string[] {
  return value
    .split(/[\r\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function sourceDisplay(source: McpSource): string {
  return source.url || "Remote endpoint not set";
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

function sharedHeaderSlots(
  values: Record<string, string>
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
      target: { kind: "header", name } as const,
      valueType: "secret" as const
    };
  });
  return { sharedValues, slots };
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

const REMOTE_ONLY_MESSAGE = "Only remote MCP URLs are supported.";

function importedConfigSource(config: Record<string, unknown>): McpSource {
  const url = typeof config.url === "string"
    ? config.url
    : typeof config.endpoint === "string"
      ? config.endpoint
      : null;
  if (!url) throw new Error(REMOTE_ONLY_MESSAGE);
  return {
    kind: "remote",
    url,
    ...(config.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {})
  };
}

function importedName(name: string, source: McpSource): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  try {
    return new URL(source.url).hostname;
  } catch {
    return "Remote MCP";
  }
}

export function normalizeMcpImport(raw: string): NormalizedMcpImport {
  const text = raw.trim();
  if (!text) throw new Error("Paste an MCP URL or JSON configuration.");

  if (/^https?:\/\//iu.test(text)) {
    const draft = defaultMcpDraft();
    draft.source = { kind: "remote", url: text };
    if (isHostedNotionMcp(draft.source)) {
      draft.auth = preparedMcpOAuthPolicy(draft.source);
    }
    return { description: "", draft, name: importedName("", draft.source), sharedValues: {} };
  }

  if (!text.startsWith("{") && !text.startsWith("[")) throw new Error(REMOTE_ONLY_MESSAGE);
  let decoded: unknown;
  try {
    decoded = parseMcpImportJson(text);
  } catch {
    throw new Error("The MCP configuration is not valid JSON. Trailing commas are accepted; check quotes, commas, and brackets.");
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

  const source = importedConfigSource(config);
  const boundValues = sharedHeaderSlots(stringRecord(config.headers));
  const draft = defaultMcpDraft();
  draft.source = source;
  draft.slots = boundValues.slots;
  if (config.auth === "oauth" || isHostedNotionMcp(source)) {
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
