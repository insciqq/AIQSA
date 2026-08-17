import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import { LEGACY_MCP_DISCOVERY_MAX_RESULTS } from "./discovery";
import type {
  McpCapabilityCatalog,
  McpCapabilityCatalogServer,
  McpCapabilityCatalogTool,
  McpDiscoveryEpoch,
  McpDiscoveryState
} from "./runPlan";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function catalogTool(value: unknown): McpCapabilityCatalogTool | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "arguments",
    "description",
    "namespacedName",
    "originalName",
    "title"
  ]) || (value.description !== null && typeof value.description !== "string") ||
    !nonBlank(value.namespacedName) || !nonBlank(value.originalName) ||
    (value.title !== undefined && !nonBlank(value.title)) ||
    (value.arguments !== undefined && !Array.isArray(value.arguments))) {
    return null;
  }
  const argumentsValue = (value.arguments ?? []).flatMap((argument) => {
    if (!isRecord(argument) || !hasOnlyKeys(argument, ["description", "name", "types"]) ||
      (argument.description !== null && typeof argument.description !== "string") ||
      !nonBlank(argument.name) || !Array.isArray(argument.types) ||
      argument.types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) ||
      new Set(argument.types).size !== argument.types.length) {
      return [];
    }
    return [{
      description: argument.description as string | null,
      name: argument.name,
      types: argument.types as string[]
    }];
  });
  if (Array.isArray(value.arguments) && argumentsValue.length !== value.arguments.length) {
    return null;
  }
  return {
    arguments: argumentsValue,
    description: value.description as string | null,
    namespacedName: value.namespacedName,
    originalName: value.originalName,
    ...(typeof value.title === "string" ? { title: value.title } : {})
  };
}

function catalogServer(value: unknown): McpCapabilityCatalogServer | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "description",
    "instructions",
    "namespace",
    "revisionId",
    "serverId",
    "serverName",
    "tools"
  ]) || typeof value.description !== "string" ||
    (value.instructions !== undefined && typeof value.instructions !== "string") ||
    !nonBlank(value.namespace) || !nonBlank(value.revisionId) ||
    !nonBlank(value.serverId) || !nonBlank(value.serverName) || !Array.isArray(value.tools)) {
    return null;
  }
  const tools = value.tools.flatMap((tool) => {
    const decoded = catalogTool(tool);
    return decoded ? [decoded] : [];
  });
  if (tools.length !== value.tools.length ||
    new Set(tools.map((tool) => tool.namespacedName)).size !== tools.length) {
    return null;
  }
  return {
    description: value.description,
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    namespace: value.namespace,
    revisionId: value.revisionId,
    serverId: value.serverId,
    serverName: value.serverName,
    tools
  };
}

function catalog(value: unknown): McpCapabilityCatalog | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["servers", "version"]) ||
    value.version !== 1 || !Array.isArray(value.servers)) return null;
  const servers = value.servers.flatMap((server) => {
    const decoded = catalogServer(server);
    return decoded ? [decoded] : [];
  });
  const toolIds = servers.flatMap((server) => server.tools.map((tool) => tool.namespacedName));
  if (servers.length !== value.servers.length ||
    new Set(servers.map((server) => server.serverId)).size !== servers.length ||
    new Set(toolIds).size !== toolIds.length) return null;
  return { servers, version: 1 };
}

function epoch(
  value: unknown,
  expectedOrdinal: number,
  catalogToolIds: ReadonlySet<string>,
  maxResults: number
): McpDiscoveryEpoch | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "epoch",
    "goal",
    "modelRunToolCallId",
    "roundIndex",
    "toolIds"
  ]) || value.epoch !== expectedOrdinal || !nonBlank(value.goal) || value.goal.length > 400 ||
    !nonBlank(value.modelRunToolCallId) || !Number.isSafeInteger(value.roundIndex) ||
    Number(value.roundIndex) < 0 || !Array.isArray(value.toolIds) ||
    value.toolIds.length > maxResults ||
    value.toolIds.some((toolId) => typeof toolId !== "string" || !catalogToolIds.has(toolId)) ||
    new Set(value.toolIds).size !== value.toolIds.length) {
    return null;
  }
  return {
    epoch: expectedOrdinal,
    goal: value.goal,
    modelRunToolCallId: value.modelRunToolCallId,
    roundIndex: Number(value.roundIndex),
    toolIds: value.toolIds as string[]
  };
}

export function decodeMcpDiscoveryState(
  value: unknown,
  maxResults = LEGACY_MCP_DISCOVERY_MAX_RESULTS
): McpDiscoveryState | null {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 ||
    maxResults > MCP_RUN_PLAN_LIMITS.maxTools) return null;
  if (!isRecord(value) || !hasOnlyKeys(value, ["catalog", "epochs", "version"]) ||
    value.version !== 2 || !Array.isArray(value.epochs)) return null;
  const decodedCatalog = catalog(value.catalog);
  if (!decodedCatalog) return null;
  const catalogToolIds = new Set(decodedCatalog.servers.flatMap((server) =>
    server.tools.map((tool) => tool.namespacedName)
  ));
  const epochs = value.epochs.flatMap((candidate, index) => {
    const decoded = epoch(candidate, index + 1, catalogToolIds, maxResults);
    return decoded ? [decoded] : [];
  });
  if (epochs.length !== value.epochs.length ||
    new Set(epochs.map((candidate) => candidate.modelRunToolCallId)).size !== epochs.length) {
    return null;
  }
  return { catalog: decodedCatalog, epochs, version: 2 };
}
