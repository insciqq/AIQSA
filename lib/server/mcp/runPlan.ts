import { hashCanonicalMcpValue } from "./definitions";
import { getMcpResponseWireLimits } from "./responseLimits";
import type { McpRuntimeTimeouts } from "../../contracts/mcp";
import {
  isMcpReadinessStartable,
  isMcpToolExclusionReason,
  isMcpToolName,
  MCP_INVENTORY_EXCLUSION_LIMIT,
  MCP_RUN_PLAN_LIMITS,
  MCP_SERVER_TOOL_LIMIT,
  mcpRuntimeErrorCode,
  type McpCredentialSource,
  type McpReadiness,
  type McpToolArgumentInventoryEntry,
  type McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import type { McpRuntimeInventoryExclusion, McpRuntimeInventoryTool } from "./runtimeCoordinator";

const INVENTORY_FRESH_MS = 5 * 60_000;

export type McpRunPlanRecord = {
  runtimeTimeouts?: McpRuntimeTimeouts;
  catalogTools?: McpToolInventoryEntry[];
  credentialSources: McpCredentialSource[];
  enabled: boolean;
  errorCode: string | null;
  externalAccountLabel: string | null;
  fingerprint: string | null;
  generationId: string | null;
  inventory: unknown;
  inventoryUpdatedAt: Date | null;
  namespace: string;
  readiness: McpReadiness;
  revisionId: string;
  serverId: string;
  serverDescription?: string;
  serverInstructions?: string;
  serverName: string;
  /**
   * A personal owner's switched-off tools. The loader already filters them
   * from the projection; the set only names why a requested tool is missing.
   */
  userDisabledToolNames?: readonly string[];
};

export type McpRunPlanBinding = {
  fingerprint: string;
  runtimeGenerationId: string;
  serverId: string;
};

export type McpRunPlanTool = McpRuntimeInventoryTool & {
  namespacedName: string;
  originalName: string;
  serverId: string;
  serverName: string;
};

export type McpCapabilityCatalogTool = {
  arguments?: McpToolArgumentInventoryEntry[];
  description: string | null;
  namespacedName: string;
  originalName: string;
  title?: string;
};

export type McpCapabilityCatalogServer = {
  runtimeTimeouts?: McpRuntimeTimeouts;
  description: string;
  instructions?: string;
  namespace: string;
  revisionId: string;
  serverId: string;
  serverName: string;
  tools: McpCapabilityCatalogTool[];
};

/** Private, schema-free catalog frozen at run admission for Auto discovery. */
export type McpCapabilityCatalog = {
  servers: McpCapabilityCatalogServer[];
  version: 1;
};

export type McpDiscoveryEpoch = {
  epoch: number;
  /** The call's find_tools query; the field keeps its historical name. */
  goal: string;
  modelRunToolCallId: string;
  roundIndex: number;
  toolIds: string[];
};

export type McpDiscoveryState = {
  catalog: McpCapabilityCatalog;
  epochs: McpDiscoveryEpoch[];
  version: 2;
};

export type McpRunPlanSnapshot = {
  servers: {
    runtimeTimeouts?: McpRuntimeTimeouts;
    credentialSources?: McpCredentialSource[];
    externalAccountLabel?: string | null;
    fingerprint: string;
    revisionId: string;
    serverId: string;
    serverName: string;
  }[];
  tools: McpRunPlanTool[];
  version: 1;
};

export type McpRunPlanIssue = {
  errorCode: string | null;
  name: string;
  /** The upstream rejected the user's own personal value or OAuth token, not an administrator's. */
  personalCredentialRejected?: true;
  readiness: McpReadiness;
};

export type McpRunPlanResult =
  | {
      bindings: McpRunPlanBinding[];
      ok: true;
      snapshot: McpRunPlanSnapshot;
    }
  | {
      code: "mcp_not_ready" | "mcp_plan_too_large";
      issues: McpRunPlanIssue[];
      /** The exceeded bound when a whole plan offers more than `MCP_RUN_PLAN_LIMITS.maxTools`. */
      limit?: "maxTools";
      ok: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Held-back names persisted with a runtime inventory. An inventory written
 * before exclusions were recorded has none; a malformed list makes the whole
 * inventory invalid.
 */
export function mcpInventoryExclusions(inventory: unknown): McpRuntimeInventoryExclusion[] | null {
  if (!isRecord(inventory)) return null;
  if (!Object.hasOwn(inventory, "exclusions")) return [];
  if (!Array.isArray(inventory.exclusions) || inventory.exclusions.length > MCP_INVENTORY_EXCLUSION_LIMIT) return null;
  const names = new Set<string>();
  const exclusions: McpRuntimeInventoryExclusion[] = [];
  for (const candidate of inventory.exclusions) {
    if (!isRecord(candidate) || !isMcpToolName(candidate.name) || names.has(candidate.name) ||
      !isMcpToolExclusionReason(candidate.reason)) return null;
    names.add(candidate.name);
    exclusions.push({ name: candidate.name, reason: candidate.reason });
  }
  return exclusions;
}

function inventoryTools(value: unknown): McpRuntimeInventoryTool[] | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tools) ||
    value.tools.length > MCP_SERVER_TOOL_LIMIT) return null;
  const exclusions = mcpInventoryExclusions(value);
  if (!exclusions) return null;
  const excluded = new Set(exclusions.map(({ name }) => name));
  const tools: McpRuntimeInventoryTool[] = [];
  for (const candidate of value.tools) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name.trim() ||
      excluded.has(candidate.name) ||
      typeof candidate.definitionHash !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.definitionHash) ||
      !isRecord(candidate.inputSchema) ||
      (candidate.description !== null && typeof candidate.description !== "string")) return null;
    if (candidate.outputSchema !== undefined && !isRecord(candidate.outputSchema)) return null;
    tools.push(candidate as McpRuntimeInventoryTool);
  }
  return tools;
}

function hasCurrentRunnableGeneration(
  record: McpRunPlanRecord,
  now: Date
): boolean {
  return Boolean(
    record.enabled &&
    record.readiness === "ready" &&
    record.generationId &&
    record.fingerprint &&
    record.inventoryUpdatedAt &&
    now.getTime() - record.inventoryUpdatedAt.getTime() <= INVENTORY_FRESH_MS
  );
}

/** Canonical pure readiness predicate shared by catalog availability and run
 * admission. Persisted `ready` is insufficient: the exact generation must be
 * live in this process, its inventory fresh, and every tool shape valid. */
export function isMcpRunPlanRecordRunnable(input: {
  isGenerationLive(generationId: string): boolean;
  now: Date;
  record: McpRunPlanRecord;
}): boolean {
  return hasCurrentRunnableGeneration(input.record, input.now) &&
    input.isGenerationLive(input.record.generationId!) &&
    inventoryTools(input.record.inventory) !== null;
}

/**
 * Pre-admission availability predicate. Unlike exact runnability, this does
 * not require a live process-local generation or fresh inventory because run
 * admission starts and reconciles these enabled states on demand.
 */
export function isMcpRunPlanRecordStartable(record: McpRunPlanRecord): boolean {
  return record.enabled && isMcpReadinessStartable(record.readiness);
}

/**
 * Run-plan rows deliberately do not decrypt user configuration, so an enabled
 * row without a desired generation can only say "queued". Availability
 * surfaces must overlay the user catalog's configuration/OAuth-aware state
 * before applying the startable predicate. A missing catalog row fails closed.
 */
export function projectMcpRunPlanStartability(
  records: readonly McpRunPlanRecord[],
  servers: readonly Readonly<{
    enabled: boolean;
    errorCode: string | null;
    id: string;
    readiness: McpReadiness;
  }>[]
): McpRunPlanRecord[] {
  const serverById = new Map(servers.map((server) => [server.id, server]));
  return records.map((record) => {
    const server = serverById.get(record.serverId);
    return server
      ? {
          ...record,
          enabled: server.enabled,
          errorCode: server.errorCode,
          readiness: server.readiness
        }
      : {
          ...record,
          enabled: false,
          errorCode: "mcp_startability_unknown",
          readiness: "unavailable"
        };
  });
}

function token(value: string, maxLength: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return (normalized || "tool").slice(0, maxLength);
}

export function namespacedMcpToolName(namespace: string, originalName: string): string {
  const suffix = hashCanonicalMcpValue({ namespace, originalName }).slice(0, 10);
  return `mcp_${token(namespace, 20)}_${token(originalName, 24)}_${suffix}`.slice(0, 64);
}

/**
 * Characters of server-supplied instructions one Auto catalog carries to its
 * router prompt, across all servers. Validation keeps each server's
 * instructions whole; only this shared prompt projection is shortened.
 */
export const MCP_CATALOG_INSTRUCTIONS_BUDGET_CHARS = 32_768;

function truncatedInstructions(text: string, maxCharacters: number): string {
  const marker = (shown: number) => `\n[Server instructions truncated: ${shown} of ${text.length} characters shown.]`;
  let shown = Math.max(0, maxCharacters - marker(maxCharacters).length);
  // Never split a UTF-16 surrogate pair.
  const last = text.charCodeAt(shown - 1);
  if (shown > 0 && last >= 0xd800 && last <= 0xdbff) shown -= 1;
  return `${text.slice(0, shown)}${marker(shown)}`;
}

/**
 * Shares one character budget across server instructions without dropping
 * any server: texts within an even share stay whole, the rest split what is
 * left and end with a visible truncation marker.
 */
export function budgetMcpServerInstructions(
  instructions: readonly string[],
  budget = MCP_CATALOG_INSTRUCTIONS_BUDGET_CHARS
): string[] {
  const result = [...instructions];
  const order = result.map((text, index) => ({ index, length: text.length }))
    .sort((left, right) => left.length - right.length || left.index - right.index);
  let remaining = budget;
  for (const [position, { index, length }] of order.entries()) {
    const share = Math.floor(remaining / (order.length - position));
    if (length <= share) {
      remaining -= length;
      continue;
    }
    result[index] = truncatedInstructions(result[index]!, share);
    remaining -= share;
  }
  return result;
}

export function buildMcpCapabilityCatalog(
  records: readonly McpRunPlanRecord[]
): McpCapabilityCatalog {
  const catalog: McpCapabilityCatalog = {
    servers: records
      .map((record) => ({
        description: record.serverDescription ?? "",
        ...(record.runtimeTimeouts ? { runtimeTimeouts: record.runtimeTimeouts } : {}),
        instructions: record.serverInstructions ?? "",
        namespace: record.namespace,
        revisionId: record.revisionId,
        serverId: record.serverId,
        serverName: record.serverName,
        tools: (record.catalogTools ?? []).map((tool) => ({
          arguments: tool.arguments ?? [],
          description: tool.description,
          namespacedName: namespacedMcpToolName(record.namespace, tool.name),
          originalName: tool.name,
          ...(tool.title ? { title: tool.title } : {})
        }))
      }))
      .filter((server) => server.tools.length > 0)
      .sort((left, right) =>
        left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId)
      ),
    version: 1
  };
  // The frozen catalog is persisted with the run and is the router's input.
  const instructions = budgetMcpServerInstructions(catalog.servers.map((server) => server.instructions ?? ""));
  catalog.servers.forEach((server, index) => { server.instructions = instructions[index]!; });
  return catalog;
}

/** A runtime that authenticates with the user's own credential failed authorization upstream. */
function personalCredentialRejected(record: McpRunPlanRecord): { personalCredentialRejected?: true } {
  return record.errorCode !== null && mcpRuntimeErrorCode(record.errorCode) === "mcp_authorization_required" &&
    record.credentialSources.some((source) => source === "personal" || source === "oauth")
    ? { personalCredentialRejected: true }
    : {};
}

function issues(records: readonly McpRunPlanRecord[]): McpRunPlanIssue[] {
  return records.map((record) => ({
    errorCode: record.errorCode,
    name: record.serverName,
    ...personalCredentialRejected(record),
    readiness: record.readiness
  }));
}

/**
 * The servers whose upstream rejected the user's own credential, or whose
 * personal OAuth connection needs (re)authorization. A shared credential the
 * administrator owns is never reported as the user's.
 */
export function mcpPersonalCredentialRejections(issues: readonly McpRunPlanIssue[]): string[] {
  return [...new Set(issues.filter((issue) => issue.personalCredentialRejected === true ||
    issue.readiness === "needs_authorization" || issue.readiness === "reauthorization_required"
  ).map((issue) => issue.name))];
}

export function buildMcpRunPlan(
  records: readonly McpRunPlanRecord[],
  now: Date,
  isGenerationLive: (generationId: string) => boolean,
  allowedToolNames?: ReadonlySet<string>
): McpRunPlanResult {
  if (records.length > MCP_RUN_PLAN_LIMITS.maxEnabledServers) {
    return { code: "mcp_plan_too_large", issues: issues(records), ok: false };
  }
  const unavailable = records.filter((record) =>
    !isMcpRunPlanRecordRunnable({ isGenerationLive, now, record })
  );
  if (unavailable.length) {
    return {
      code: "mcp_not_ready",
      issues: unavailable.map((record) => {
        if (
          hasCurrentRunnableGeneration(record, now) &&
          !isGenerationLive(record.generationId!)
        ) {
          return {
            errorCode: "mcp_runtime_not_live",
            name: record.serverName,
            readiness: "restarting" as const
          };
        }
        if (
          hasCurrentRunnableGeneration(record, now) &&
          inventoryTools(record.inventory) === null
        ) {
          return {
            errorCode: "mcp_inventory_invalid",
            name: record.serverName,
            readiness: "unavailable" as const
          };
        }
        return {
          errorCode: record.errorCode,
          name: record.serverName,
          ...personalCredentialRejected(record),
          readiness: record.readiness
        };
      }),
      ok: false
    };
  }

  const bindings: McpRunPlanBinding[] = [];
  const servers: McpRunPlanSnapshot["servers"] = [];
  const tools: McpRunPlanTool[] = [];
  let schemaBytes = 0;
  for (const record of records) {
    const inventory = inventoryTools(record.inventory)!;
    const selectedInventory = allowedToolNames
      ? inventory.filter((tool) =>
          allowedToolNames.has(namespacedMcpToolName(record.namespace, tool.name)))
      : inventory;
    if (allowedToolNames && selectedInventory.length === 0) continue;
    bindings.push({
      fingerprint: record.fingerprint!,
      runtimeGenerationId: record.generationId!,
      serverId: record.serverId
    });
    servers.push({
      ...(record.runtimeTimeouts ? { runtimeTimeouts: record.runtimeTimeouts } : {}),
      credentialSources: [...record.credentialSources],
      externalAccountLabel: record.externalAccountLabel,
      fingerprint: record.fingerprint!,
      revisionId: record.revisionId,
      serverId: record.serverId,
      serverName: record.serverName
    });
    for (const tool of selectedInventory) {
      schemaBytes += Buffer.byteLength(JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }), "utf8");
      tools.push({
        ...tool,
        namespacedName: namespacedMcpToolName(record.namespace, tool.name),
        originalName: tool.name,
        serverId: record.serverId,
        serverName: record.serverName
      });
    }
  }
  if (allowedToolNames && tools.length !== allowedToolNames.size) {
    // The owner's own switch-off is a distinct cause from a tool that left
    // the server or was filtered for another reason.
    const offered = new Set(tools.map((tool) => tool.namespacedName));
    const switchedOff = new Set(records.flatMap((record) => (record.userDisabledToolNames ?? [])
      .map((name) => namespacedMcpToolName(record.namespace, name))));
    return {
      code: "mcp_not_ready",
      issues: [{
        errorCode: [...allowedToolNames].some((name) => !offered.has(name) && switchedOff.has(name))
          ? "mcp_tool_disabled"
          : "mcp_tool_not_available",
        name: "Selected MCP tool",
        readiness: "unavailable"
      }],
      ok: false
    };
  }
  if (tools.length > MCP_RUN_PLAN_LIMITS.maxTools) {
    return { code: "mcp_plan_too_large", issues: issues(records), limit: "maxTools", ok: false };
  }
  if (schemaBytes > getMcpResponseWireLimits().listToolsResponseMaxBytes ||
    new Set(tools.map((tool) => tool.namespacedName)).size !== tools.length) {
    return { code: "mcp_plan_too_large", issues: issues(records), ok: false };
  }
  return {
    bindings,
    ok: true,
    snapshot: { servers, tools, version: 1 }
  };
}

function applyAllowedServerSubset(
  records: McpRunPlanRecord[],
  allowedServerIds: readonly string[]
): { missing: string[]; records: McpRunPlanRecord[] } {
  const allowed = new Set(allowedServerIds);
  const subset = records.filter((record) => allowed.has(record.serverId));
  const present = new Set(subset.map((record) => record.serverId));
  return {
    missing: allowedServerIds.filter((serverId) => !present.has(serverId)),
    records: subset
  };
}

export async function prepareMcpRunPlan(input: {
  /**
   * Exact required server subset. Every requested server must resolve to an
   * enabled, entitled, ready runtime for this runner; a missing or unavailable
   * requested server fails the whole plan closed, and unrelated enabled
   * servers are excluded.
   */
  allowedServerIds?: readonly string[];
  /** Optional exact tool subset for Auto materialization. Limits and schema
   * accounting apply only to these tools, never to an MCP server's full
   * inventory. */
  allowedToolNames?: readonly string[];
  isGenerationLive(generationId: string): boolean;
  load(): Promise<McpRunPlanRecord[]>;
  now?: () => Date;
  reconcile?(): Promise<void>;
}): Promise<McpRunPlanResult> {
  const allowedToolNames = input.allowedToolNames
    ? new Set(input.allowedToolNames)
    : undefined;
  if (allowedToolNames && allowedToolNames.size !== input.allowedToolNames?.length) {
    return {
      code: "mcp_not_ready",
      issues: [{
        errorCode: "mcp_tool_not_available",
        name: "Selected MCP tool",
        readiness: "unavailable"
      }],
      ok: false
    };
  }
  const build = (records: McpRunPlanRecord[], at: Date): McpRunPlanResult => {
    if (!input.allowedServerIds) {
      return buildMcpRunPlan(records, at, input.isGenerationLive, allowedToolNames);
    }
    const subset = applyAllowedServerSubset(records, input.allowedServerIds);
    if (subset.missing.length > 0) {
      return {
        code: "mcp_not_ready",
        issues: subset.missing.map(() => ({
          errorCode: "mcp_server_unavailable",
          name: "Required MCP server",
          readiness: "unavailable" as const
        })),
        ok: false
      };
    }
    return buildMcpRunPlan(subset.records, at, input.isGenerationLive, allowedToolNames);
  };

  const now = input.now?.() ?? new Date();
  let records = await input.load();
  let result = build(records, now);
  if (!result.ok && result.code === "mcp_not_ready" && input.reconcile) {
    await input.reconcile();
    records = await input.load();
    result = build(records, input.now?.() ?? new Date());
  }
  return result;
}
