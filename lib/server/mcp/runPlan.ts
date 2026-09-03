import { hashCanonicalMcpValue } from "./definitions";
import {
  isMcpReadinessStartable,
  MCP_RUN_PLAN_LIMITS,
  type McpCredentialSource,
  type McpReadiness,
  type McpToolArgumentInventoryEntry,
  type McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import type { McpRuntimeInventoryTool } from "./runtimeCoordinator";

const INVENTORY_FRESH_MS = 5 * 60_000;

export type McpRunPlanRecord = {
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

export type McpRunPlanResult =
  | {
      bindings: McpRunPlanBinding[];
      ok: true;
      snapshot: McpRunPlanSnapshot;
    }
  | {
      code: "mcp_not_ready" | "mcp_plan_too_large";
      issues: { errorCode: string | null; name: string; readiness: McpReadiness }[];
      ok: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inventoryTools(value: unknown): McpRuntimeInventoryTool[] | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tools)) return null;
  const tools: McpRuntimeInventoryTool[] = [];
  for (const candidate of value.tools) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name.trim() ||
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

export function buildMcpCapabilityCatalog(
  records: readonly McpRunPlanRecord[]
): McpCapabilityCatalog {
  return {
    servers: records
      .map((record) => ({
        description: record.serverDescription ?? "",
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
}

function issues(records: readonly McpRunPlanRecord[]) {
  return records.map((record) => ({
    errorCode: record.errorCode,
    name: record.serverName,
    readiness: record.readiness
  }));
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
  if (tools.length > MCP_RUN_PLAN_LIMITS.maxTools ||
    schemaBytes > MCP_RUN_PLAN_LIMITS.maxToolSchemaBytes ||
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
