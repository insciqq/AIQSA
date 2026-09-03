export const MEMORY_MCP_SMOKE_TOOL_NAMES = [
  "add_memory",
  "search_memories",
  "list_memories",
  "get_memory",
  "update_memory",
  "delete_memory"
] as const;

export type MemoryMcpSmokeToolName =
  (typeof MEMORY_MCP_SMOKE_TOOL_NAMES)[number];

const MEMORY_MCP_SMOKE_ERROR_CODES = [
  "memory_contract_invalid",
  "memory_unavailable",
  "memory_preparing",
  "memory_not_found",
  "memory_changed",
  "memory_secret_rejected",
  "memory_action_failed"
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquoteTomlString(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(["'])(.*)\1$/u);
  return match ? match[2] ?? null : null;
}

function assignment(line: string): Readonly<{ key: string; raw: string }> | null {
  const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u);
  if (!match || !match[1] || !match[2] || match[2].includes("#")) return null;
  return { key: match[1], raw: match[2] };
}

export function codexLbOverridesFromConfig(config: string): Readonly<{
  args: readonly string[];
  configuredModel: string;
}> {
  const topLevel = new Map<string, string>();
  const provider = new Map<string, string>();
  let section = "";

  for (const line of config.split(/\r?\n/u)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    const parsed = assignment(line);
    if (!parsed) continue;
    if (!section) topLevel.set(parsed.key, parsed.raw);
    if (section === "model_providers.codex-lb") {
      provider.set(parsed.key, parsed.raw);
    }
  }

  const providerName = unquoteTomlString(topLevel.get("model_provider") ?? "");
  const configuredModel = unquoteTomlString(topLevel.get("model") ?? "");
  if (providerName !== "codex-lb" || !configuredModel) {
    throw new Error("memory_mcp_smoke_codex_lb_profile_required");
  }

  const required = [
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "requires_openai_auth"
  ] as const;
  if (required.some((key) => !provider.has(key))) {
    throw new Error("memory_mcp_smoke_codex_lb_profile_incomplete");
  }
  if (unquoteTomlString(provider.get("env_key") ?? "") !== "CODEX_LB_API_KEY") {
    throw new Error("memory_mcp_smoke_codex_lb_env_invalid");
  }
  const baseUrl = unquoteTomlString(provider.get("base_url") ?? "");
  try {
    const parsed = new URL(baseUrl ?? "");
    if (!(["http:", "https:"].includes(parsed.protocol)) ||
      parsed.username || parsed.password || parsed.hash) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("memory_mcp_smoke_codex_lb_url_invalid");
  }

  const allowed = [
    "name",
    "base_url",
    "wire_api",
    "supports_websockets",
    "env_key",
    "requires_openai_auth"
  ] as const;
  const args = ["-c", `model_provider=${topLevel.get("model_provider")}`];
  for (const key of allowed) {
    const raw = provider.get(key);
    if (raw) args.push("-c", `model_providers.codex-lb.${key}=${raw}`);
  }
  return { args, configuredModel };
}

export function parseDisposableAdminDatabaseUrl(
  mode: string | undefined,
  value: string | undefined
): URL {
  if (mode !== "DISPOSABLE") {
    throw new Error("memory_mcp_smoke_disposable_opt_in_required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new Error("memory_mcp_smoke_admin_database_url_required");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const port = Number(parsed.port);
  if (parsed.protocol !== "postgresql:" || parsed.username !== "aiqsa" ||
    !parsed.password || !loopback || !Number.isInteger(port) || port < 1 ||
    port > 65_535 ||
    parsed.pathname !== "/postgres" || parsed.search || parsed.hash) {
    throw new Error("memory_mcp_smoke_admin_database_not_disposable");
  }
  return parsed;
}

export function ownedMemoryMcpSmokeDatabaseName(runId: string): string {
  if (!/^[a-f0-9]{12}$/u.test(runId)) {
    throw new Error("memory_mcp_smoke_run_id_invalid");
  }
  return `aiqsa_memory_mcp_e2e_${runId}`;
}

export function databaseUrlForOwnedSmoke(adminUrl: URL, databaseName: string): string {
  if (!/^aiqsa_memory_mcp_e2e_[a-f0-9]{12}$/u.test(databaseName)) {
    throw new Error("memory_mcp_smoke_database_name_invalid");
  }
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  target.searchParams.set("schema", "public");
  return target.toString();
}

export function parseCodexMcpList(value: string): readonly Readonly<{
  authStatus: string | null;
  enabled: boolean;
  name: string;
  transportType: string;
}>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("memory_mcp_smoke_codex_list_invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("memory_mcp_smoke_codex_list_invalid");
  }
  return parsed.map((item) => {
    if (!record(item) || typeof item.name !== "string" || !record(item.transport) ||
      typeof item.transport.type !== "string" || typeof item.enabled !== "boolean" ||
      item.auth_status !== null && typeof item.auth_status !== "string") {
      throw new Error("memory_mcp_smoke_codex_list_invalid");
    }
    return {
      authStatus: item.auth_status,
      enabled: item.enabled,
      name: item.name,
      transportType: item.transport.type
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function toolIdentity(item: JsonRecord): Readonly<{
  server: string | null;
  tool: string | null;
}> {
  const server = typeof item.server === "string"
    ? item.server
    : typeof item.server_name === "string"
      ? item.server_name
      : null;
  const directTool = typeof item.tool === "string"
    ? item.tool
    : typeof item.tool_name === "string"
      ? item.tool_name
      : null;
  if (server && directTool) return { server, tool: directTool };
  const name = typeof item.name === "string" ? item.name : null;
  const match = name?.match(/^mcp__(.+?)__(.+)$/u);
  return match
    ? { server: match[1] ?? null, tool: match[2] ?? null }
    : { server, tool: directTool };
}

function parsedRecord(value: unknown): JsonRecord | null {
  if (record(value)) return value;
  if (typeof value !== "string" || value.length > 256 * 1_024) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolArguments(item: JsonRecord): JsonRecord | null {
  return parsedRecord(item.arguments) ?? parsedRecord(item.input);
}

function collectMemoryRefs(
  value: unknown,
  output: Set<string>,
  depth = 0
): void {
  if (depth > 6 || output.size >= 20) return;
  if (typeof value === "string") {
    const parsed = parsedRecord(value);
    if (parsed) collectMemoryRefs(parsed, output, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) collectMemoryRefs(item, output, depth + 1);
    return;
  }
  if (!record(value)) return;
  if (typeof value.memoryRef === "string" &&
    value.memoryRef.length > 0 && value.memoryRef.length <= 2_048) {
    output.add(value.memoryRef);
  }
  for (const nested of Object.values(value)) {
    collectMemoryRefs(nested, output, depth + 1);
  }
}

function hasToolError(value: unknown, depth = 0): boolean {
  if (depth > 5 || !record(value)) return false;
  if (value.isError === true || value.is_error === true || value.status === "failed") {
    return true;
  }
  return Object.values(value).some((nested) =>
    record(nested) ? hasToolError(nested, depth + 1) : false
  );
}

export type CodexEventAudit = Readonly<{
  authorizationSignal: boolean;
  completedTools: readonly string[];
  evidence: Readonly<Record<string, boolean>>;
  eventTypes: Readonly<Record<string, number>>;
  failedTools: readonly string[];
  forbiddenItemTypes: readonly string[];
  foreignMcpCalls: number;
  invalidLines: number;
  itemTypes: Readonly<Record<string, number>>;
  mentionedToolNames: readonly string[];
  mcpFailureSignal: boolean;
  mcpSignal: boolean;
  /** Private in-process evidence. Callers must never serialize this field. */
  capturedSearchCalls: readonly Readonly<{
    limit: number | null;
    memoryRefs: readonly string[];
    query: string;
  }>[];
  toolCalls: readonly Readonly<{
    errorCodes: readonly string[];
    status: "COMPLETED" | "FAILED";
    tool: string;
  }>[];
  toolErrorCodes: Readonly<Record<string, readonly string[]>>;
  toolUnavailableSignal: boolean;
}>;

export function auditCodexJsonEvents(input: Readonly<{
  events: string;
  evidenceNeedles?: Readonly<Record<string, string>>;
  expectedServer: string;
  stderr?: string;
}>): CodexEventAudit {
  const completedTools: string[] = [];
  const failedTools: string[] = [];
  const forbiddenItemTypes = new Set<string>();
  const evidence = Object.fromEntries(
    Object.keys(input.evidenceNeedles ?? {}).map((key) => [key, false])
  );
  let foreignMcpCalls = 0;
  let invalidLines = 0;
  const eventTypes: Record<string, number> = {};
  const itemTypes: Record<string, number> = {};
  const capturedSearchCalls: Array<{
    limit: number | null;
    memoryRefs: readonly string[];
    query: string;
  }> = [];
  const toolCalls: Array<{
    errorCodes: readonly string[];
    status: "COMPLETED" | "FAILED";
    tool: string;
  }> = [];
  const toolErrorCodes: Record<string, string[]> = {};

  for (const line of input.events.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (record(event) && typeof event.type === "string") {
      eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
    }
    if (!record(event) || !record(event.item)) continue;
    const item = event.item;
    const itemType = typeof item.type === "string" ? item.type : "unknown";
    itemTypes[itemType] = (itemTypes[itemType] ?? 0) + 1;
    const identity = toolIdentity(item);
    const mcpCall = itemType === "mcp_tool_call" || Boolean(identity.server);
    if (mcpCall) {
      if (identity.server !== input.expectedServer) foreignMcpCalls += 1;
      if (!identity.tool || !MEMORY_MCP_SMOKE_TOOL_NAMES.includes(
        identity.tool as MemoryMcpSmokeToolName
      )) {
        forbiddenItemTypes.add(`mcp:${identity.tool ?? "unknown"}`);
      }
      if (event.type === "item.completed" && identity.tool) {
        if (hasToolError(item)) {
          failedTools.push(identity.tool);
          const serialized = JSON.stringify(item);
          const errorCodes = MEMORY_MCP_SMOKE_ERROR_CODES.filter(
            (code) => serialized.includes(code)
          );
          toolErrorCodes[identity.tool] = [...new Set([
            ...(toolErrorCodes[identity.tool] ?? []),
            ...errorCodes
          ])];
          toolCalls.push({ errorCodes, status: "FAILED", tool: identity.tool });
        }
        else {
          completedTools.push(identity.tool);
          toolCalls.push({ errorCodes: [], status: "COMPLETED", tool: identity.tool });
          if (identity.tool === "search_memories") {
            const argumentsRecord = toolArguments(item);
            const query = argumentsRecord?.query;
            const limit = argumentsRecord?.limit;
            const memoryRefs = new Set<string>();
            collectMemoryRefs(item.result, memoryRefs);
            if (typeof query === "string" && query.trim() &&
              query.trim().length <= 2_000) {
              capturedSearchCalls.push({
                limit: typeof limit === "number" && Number.isSafeInteger(limit) &&
                  limit >= 1 && limit <= 20 ? limit : null,
                memoryRefs: [...memoryRefs],
                query: query.trim()
              });
            }
          }
          const serialized = JSON.stringify(item);
          for (const [key, needle] of Object.entries(input.evidenceNeedles ?? {})) {
            if (serialized.includes(needle)) evidence[key] = true;
          }
        }
      }
      continue;
    }
    if ([
      "command_execution",
      "computer_action",
      "file_change",
      "image_generation",
      "tool_call",
      "web_search"
    ].includes(itemType)) {
      forbiddenItemTypes.add(itemType);
    }
  }

  const authorizationText = `${input.events}\n${input.stderr ?? ""}`;
  const mentionedToolNames = MEMORY_MCP_SMOKE_TOOL_NAMES.filter((name) =>
    authorizationText.includes(name));
  return {
    authorizationSignal: /auth(?:entication|orization)?|oauth|login|required|unauthoriz|not ready/iu
      .test(authorizationText),
    completedTools,
    evidence,
    eventTypes,
    failedTools,
    forbiddenItemTypes: [...forbiddenItemTypes].sort(),
    foreignMcpCalls,
    invalidLines,
    itemTypes,
    mentionedToolNames,
    mcpFailureSignal:
      /(?:mcp|model context protocol).{0,120}(?:fail|error|timed out|timeout|handshake|initialize|connect)/iu
        .test(authorizationText) ||
      /(?:fail|error|timed out|timeout|handshake|initialize|connect).{0,120}(?:mcp|model context protocol)/iu
        .test(authorizationText),
    mcpSignal: /\bmcp\b/iu.test(authorizationText),
    capturedSearchCalls,
    toolCalls,
    toolErrorCodes,
    toolUnavailableSignal:
      /(?:tool|mcp).{0,120}(?:not available|unavailable|not found|failed to start|cannot|can't|do not have)/iu
        .test(authorizationText) ||
      /(?:not available|unavailable|not found|failed to start|cannot|can't|do not have).{0,120}(?:tool|mcp)/iu
        .test(authorizationText)
  };
}

export function codexAgentMessageContains(
  events: string,
  expected: string
): boolean {
  const needle = expected.trim().toLocaleLowerCase("en-US");
  if (!needle) return false;
  for (const line of events.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record(event) || event.type !== "item.completed" ||
      !record(event.item) || event.item.type !== "agent_message" ||
      typeof event.item.text !== "string") continue;
    if (event.item.text.toLocaleLowerCase("en-US").includes(needle)) {
      return true;
    }
  }
  return false;
}

export function findAuthorizationUrl(text: string, issuer: string): string | null {
  const expected = new URL(issuer);
  const candidates = text.match(/https?:\/\/[^\s\u0000-\u001f"'<>]+/gu) ?? [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate.replace(/[),.;]+$/u, ""));
      if (parsed.origin === expected.origin && parsed.pathname === "/oauth/authorize") {
        return parsed.toString();
      }
    } catch {
      // Continue scanning bounded child output for the actual authorization URL.
    }
  }
  return null;
}

export function parseInspectorInitialize(value: string): Readonly<{
  protocolVersion: string;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("memory_mcp_smoke_inspector_initialize_invalid");
  }
  const result = record(parsed) && record(parsed.result) ? parsed.result : null;
  if (!result || typeof result.protocolVersion !== "string") {
    throw new Error("memory_mcp_smoke_inspector_initialize_invalid");
  }
  return { protocolVersion: result.protocolVersion };
}

export function parseInspectorToolNames(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("memory_mcp_smoke_inspector_tools_invalid");
  }
  const result = record(parsed) && record(parsed.result) ? parsed.result : null;
  if (!result || !Array.isArray(result.tools)) {
    throw new Error("memory_mcp_smoke_inspector_tools_invalid");
  }
  return result.tools.map((tool) => {
    if (!record(tool) || typeof tool.name !== "string") {
      throw new Error("memory_mcp_smoke_inspector_tools_invalid");
    }
    return tool.name;
  });
}
