import { Prisma, type PrismaClient } from "@prisma/client";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { isMcpRuntimeTimeouts } from "../../contracts/mcp";
import type {
  McpToolArgumentInventoryEntry,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import { loadMcpToolAccess } from "./toolAccess";
import { personalMcpCatalogTools, personalMcpLiveTools } from "./personalCatalog";
import {
  buildMcpCapabilityCatalog,
  mcpCatalogOmissions,
  mcpInventoryExclusions,
  type McpCapabilityCatalog,
  type McpCatalogOmission,
  type McpRunPlanRecord
} from "./runPlan";

function runtimeTimeouts(configuration: unknown) {
  const runtime = configuration && typeof configuration === "object" && "runtime" in configuration ? configuration.runtime : undefined;
  return isMcpRuntimeTimeouts(runtime) ? { runtimeTimeouts: runtime } : {};
}

const runPlanPreferenceSelect = {
  desiredRuntimeGeneration: {
    select: {
      credentialSources: true,
      errorCode: true,
      externalAccountLabel: true,
      fingerprint: true,
      id: true,
      inventory: true,
      inventoryUpdatedAt: true,
      oauthConnectionId: true,
      revisionId: true,
      state: true,
      userServerId: true
    }
  },
  desiredRuntimeGenerationId: true,
  discoveredInventory: true,
  discoveredOAuthConnectionId: true,
  discoveredRevisionId: true,
  enabled: true,
  id: true,
  runtimeGenerations: {
    orderBy: { updatedAt: "desc" },
    take: 8,
    select: {
      inventory: true,
      oauthConnectionId: true,
      revisionId: true,
      state: true
    }
  },
  server: {
    select: {
      activeRevision: {
        select: {
          configuration: true,
          validationEvidence: true
        }
      },
      activeRevisionId: true,
      archivedAt: true,
      description: true,
      displayName: true,
      enabled: true,
      grants: {
        select: {
          canUse: true,
          groupId: true,
          userId: true
        }
      },
      id: true,
      ownerUserId: true,
      namespace: true,
      oauthConnections: {
        where: { purpose: "user" },
        select: { disconnectRequestedAt: true, id: true, state: true, userId: true }
      }
    }
  },
  user: {
    select: {
      groups: {
        select: { groupId: true },
        where: { group: { archivedAt: null } }
      },
      status: true
    }
  },
  userDisabledToolNames: true,
  userId: true
} satisfies Prisma.McpUserServerSelect;

type RunPlanPreferenceRecord = Prisma.McpUserServerGetPayload<{
  select: typeof runPlanPreferenceSelect;
}>;

function inaccessibleRecord(
  preference: RunPlanPreferenceRecord,
  errorCode: string
): McpRunPlanRecord {
  return {
    // A revoked grant or unavailable server must not leak tool metadata into
    // the user's private Auto-discovery catalog.
    catalogTools: [],
    credentialSources: [],
    enabled: preference.enabled,
    errorCode,
    externalAccountLabel: null,
    fingerprint: null,
    generationId: null,
    inventory: null,
    inventoryUpdatedAt: null,
    namespace: preference.server.namespace,
    readiness: "unavailable",
    revisionId: preference.server.activeRevisionId ?? "",
    serverId: preference.server.id,
    serverDescription: preference.server.description,
    serverName: preference.server.displayName
  };
}

function runtimeReadiness(state: string, errorCode: string | null): {
  errorCode: string | null;
  readiness: McpReadiness;
} {
  if (state === "ready") return { errorCode: null, readiness: "ready" };
  if (state === "starting") return { errorCode: null, readiness: "starting" };
  if (state === "idle") return { errorCode: null, readiness: "idle" };
  if (state === "stopping") return { errorCode: null, readiness: "restarting" };
  return { errorCode: errorCode ?? "mcp_runtime_unavailable", readiness: "unavailable" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configurationDisabledToolNames(configuration: unknown): string[] {
  return isRecord(configuration) && Array.isArray(configuration.disabledToolNames)
    ? configuration.disabledToolNames.filter((name): name is string => typeof name === "string")
    : [];
}

function revisionCatalogTools(
  validationEvidence: unknown,
  configuration: unknown
): McpToolInventoryEntry[] {
  if (!isRecord(validationEvidence) || !Array.isArray(validationEvidence.toolInventory)) return [];
  const disabled = new Set(configurationDisabledToolNames(configuration));
  return validationEvidence.toolInventory.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name.trim() ||
      disabled.has(candidate.name) ||
      !(candidate.description === null || typeof candidate.description === "string")) return [];
    const argumentsValue: McpToolArgumentInventoryEntry[] = Array.isArray(candidate.arguments)
      ? candidate.arguments.flatMap((argument) => {
          if (!isRecord(argument) || typeof argument.name !== "string" ||
            !argument.name.trim() ||
            (argument.description !== null && typeof argument.description !== "string") ||
            !Array.isArray(argument.types) || argument.types.length > 7 ||
            argument.types.some((type) => typeof type !== "string" || type.length > 32)) return [];
          return [{
            description: argument.description as string | null,
            name: argument.name,
            types: argument.types as string[]
          }];
        })
      : [];
    return [{
      arguments: argumentsValue,
      description: candidate.description as string | null,
      name: candidate.name,
      ...(typeof candidate.title === "string" && candidate.title.trim()
        ? { title: candidate.title.trim() }
        : {})
    }];
  });
}

/**
 * An installation server's published catalog minus what the generation's
 * persisted inventory holds back. A malformed inventory subtracts nothing:
 * materialization then fails closed as `mcp_inventory_invalid` instead of the
 * server silently vanishing.
 */
function currentCatalogTools(
  validationEvidence: unknown,
  configuration: unknown,
  inventory: unknown
): McpToolInventoryEntry[] {
  const excluded = new Set((mcpInventoryExclusions(inventory) ?? []).map(({ name }) => name));
  return revisionCatalogTools(validationEvidence, configuration).filter(({ name }) => !excluded.has(name));
}

function revisionServerInstructions(validationEvidence: unknown): string | undefined {
  if (!isRecord(validationEvidence) || !isRecord(validationEvidence.evidence) ||
    !isRecord(validationEvidence.evidence.server) ||
    typeof validationEvidence.evidence.server.instructions !== "string") return undefined;
  // Kept whole: the Auto catalog applies one visible shared budget instead.
  return validationEvidence.evidence.server.instructions.trim() || undefined;
}

/**
 * A personal server's catalog follows its live inventory minus the owner's
 * switched-off tools; the published revision only lends argument summaries and
 * titles. This is a projection lookup; it never wakes a runtime.
 */
function personalCatalogTools(
  preference: RunPlanPreferenceRecord,
  current: RunPlanPreferenceRecord["desiredRuntimeGeneration"]
): McpToolInventoryEntry[] {
  const configuration = preference.server.activeRevision?.configuration;
  const live = personalMcpLiveTools({
    activeRevisionId: preference.server.activeRevisionId!,
    current,
    discovered: {
      inventory: preference.discoveredInventory,
      oauthConnectionId: preference.discoveredOAuthConnectionId,
      revisionId: preference.discoveredRevisionId
    },
    disabledByConfiguration: configurationDisabledToolNames(configuration),
    oauthMode: authMode(configuration) === "oauth",
    readyOAuthConnectionIds: new Set(preference.server.oauthConnections
      .filter((connection) => connection.userId === preference.userId &&
        connection.state === "ready" && connection.disconnectRequestedAt === null)
      .map((connection) => connection.id)),
    recent: preference.runtimeGenerations
  });
  return personalMcpCatalogTools(
    live,
    revisionCatalogTools(preference.server.activeRevision?.validationEvidence, configuration),
    preference.userDisabledToolNames
  );
}

/**
 * A personal OAuth connection whose owner holds no ready token lost its
 * authority. Dispatch and admission name that state instead of a queued
 * runtime that synchronization can never start.
 */
function personalAuthorizationLoss(
  preference: RunPlanPreferenceRecord
): { errorCode: string; readiness: "needs_authorization" | "reauthorization_required" } | null {
  if (authMode(preference.server.activeRevision?.configuration) !== "oauth") return null;
  const owned = preference.server.oauthConnections.filter((connection) =>
    connection.userId === preference.userId && connection.disconnectRequestedAt === null);
  if (owned.some((connection) => connection.state === "ready")) return null;
  return owned.some((connection) => connection.state === "reauthorization_required")
    ? { errorCode: "oauth_reauthorization_required", readiness: "reauthorization_required" }
    : { errorCode: "oauth_required", readiness: "needs_authorization" };
}

/** Every record of the runner's own personal server says so, whatever its state. */
function serializeRunPlanPreference(preference: RunPlanPreferenceRecord): McpRunPlanRecord {
  const record = serializeRunPlanPreferenceState(preference);
  return preference.server.ownerUserId === preference.userId ? { ...record, personal: true } : record;
}

function serializeRunPlanPreferenceState(preference: RunPlanPreferenceRecord): McpRunPlanRecord {
  const groupIds = new Set(preference.user.groups.map((membership) => membership.groupId));
  const canUse = preference.server.ownerUserId != null
    ? preference.server.ownerUserId === preference.userId
    : preference.server.grants.some((grant) => grant.canUse && (
    grant.userId === preference.userId || Boolean(grant.groupId && groupIds.has(grant.groupId))
  ));
  if (preference.user.status !== "active" || !canUse) {
    return inaccessibleRecord(preference, "mcp_access_revoked");
  }
  if (!preference.server.enabled || preference.server.archivedAt || !preference.server.activeRevisionId) {
    return inaccessibleRecord(preference, "mcp_server_unavailable");
  }
  if (!preference.enabled) {
    return {
      ...inaccessibleRecord(preference, "mcp_user_disabled"),
      errorCode: null,
      readiness: "disabled"
    };
  }
  const serverInstructions = revisionServerInstructions(
    preference.server.activeRevision?.validationEvidence
  );
  const personal = preference.server.ownerUserId === preference.userId;
  const authorization = personal ? personalAuthorizationLoss(preference) : null;
  if (authorization) return { ...inaccessibleRecord(preference, authorization.errorCode), readiness: authorization.readiness };
  const switchedOff = personal ? { userDisabledToolNames: preference.userDisabledToolNames } : {};

  const generation = preference.desiredRuntimeGeneration;
  if (!generation) {
    return {
      ...inaccessibleRecord(
        preference,
        preference.desiredRuntimeGenerationId ? "mcp_runtime_stale" : "mcp_runtime_pending"
      ),
      ...runtimeTimeouts(preference.server.activeRevision?.configuration),
      catalogTools: personal
        ? personalCatalogTools(preference, null)
        : currentCatalogTools(
            preference.server.activeRevision?.validationEvidence,
            preference.server.activeRevision?.configuration,
            null
          ),
      ...(serverInstructions ? { serverInstructions } : {}),
      ...switchedOff,
      errorCode: preference.desiredRuntimeGenerationId ? "mcp_runtime_stale" : null,
      readiness: preference.desiredRuntimeGenerationId ? "unavailable" : "queued"
    };
  }
  if (preference.desiredRuntimeGenerationId !== generation.id || generation.userServerId !== preference.id) {
    return inaccessibleRecord(preference, "mcp_runtime_stale");
  }
  if (generation.revisionId !== preference.server.activeRevisionId) {
    return inaccessibleRecord(preference, "mcp_revision_changed");
  }

  const runtime = runtimeReadiness(generation.state, generation.errorCode);
  return {
    ...runtimeTimeouts(preference.server.activeRevision?.configuration),
    catalogTools: personal
      ? personalCatalogTools(preference, generation)
      : currentCatalogTools(
          preference.server.activeRevision?.validationEvidence,
          preference.server.activeRevision?.configuration,
          generation.inventory
        ),
    credentialSources: generation.credentialSources.filter((source): source is "oauth" | "personal" | "shared" =>
      source === "oauth" || source === "personal" || source === "shared"),
    enabled: preference.enabled,
    errorCode: runtime.errorCode,
    externalAccountLabel: generation.externalAccountLabel,
    fingerprint: generation.fingerprint,
    generationId: generation.id,
    inventory: generation.inventory,
    inventoryUpdatedAt: generation.inventoryUpdatedAt,
    namespace: preference.server.namespace,
    readiness: runtime.readiness,
    revisionId: generation.revisionId,
    serverId: preference.server.id,
    serverDescription: preference.server.description,
    ...(serverInstructions ? { serverInstructions } : {}),
    serverName: preference.server.displayName,
    ...switchedOff
  };
}

const projectRunServerSelect = {
  activeRevision: {
    select: {
      configuration: true,
      validationEvidence: true
    }
  },
  activeRevisionId: true,
  archivedAt: true,
  description: true,
  displayName: true,
  enabled: true,
  id: true,
  ownerUserId: true,
  namespace: true,
  sharedConfigEnvelope: true,
  sharedRuntime: {
    select: {
      desiredRuntimeGeneration: {
        select: {
          credentialSources: true,
          errorCode: true,
          fingerprint: true,
          id: true,
          inventory: true,
          inventoryUpdatedAt: true,
          oauthConnectionId: true,
          revisionId: true,
          sharedServerId: true,
          state: true,
          userServerId: true
        }
      }
    }
  }
} satisfies Prisma.McpServerSelect;

type ProjectRunServerRecord = Prisma.McpServerGetPayload<{
  select: typeof projectRunServerSelect;
}>;

function authMode(configuration: unknown): string | null {
  if (!isRecord(configuration) || !isRecord(configuration.auth) ||
    typeof configuration.auth.mode !== "string") return null;
  return configuration.auth.mode;
}

/** An OAuth identity or a personal-only value can never back a Project runtime. */
function requiresPersonalCredentials(configuration: unknown): boolean {
  return authMode(configuration) === "oauth" || (
    isRecord(configuration) && Array.isArray(configuration.slots) &&
    configuration.slots.some((slot) => isRecord(slot) && isRecord(slot.policy) && slot.policy.kind === "personal")
  );
}

/**
 * Resolve a Project MCP plan from the server's installation-owned shared
 * runtime only: never through McpGrant, a member's McpUserServer or a
 * generation some member started. Only a shared generation of the active
 * revision without OAuth or personal credential sources can cross this
 * boundary; the initiator's tool restrictions are applied afterwards.
 */
function serializeProjectRunServer(server: ProjectRunServerRecord): McpRunPlanRecord {
  const configuration = server.activeRevision?.configuration;
  const unavailable = (errorCode: string): McpRunPlanRecord => ({
    ...runtimeTimeouts(configuration),
    catalogTools: [],
    credentialSources: [],
    enabled: false,
    errorCode,
    externalAccountLabel: null,
    fingerprint: null,
    generationId: null,
    inventory: null,
    inventoryUpdatedAt: null,
    namespace: server.namespace,
    readiness: "unavailable",
    revisionId: server.activeRevisionId ?? "",
    serverDescription: server.description,
    serverId: server.id,
    serverName: server.displayName
  });
  if (!server.enabled || server.archivedAt || !server.activeRevisionId || !server.activeRevision) {
    return unavailable("mcp_server_unavailable");
  }
  if (server.ownerUserId !== null) return unavailable("mcp_project_credentials_unavailable");
  if (requiresPersonalCredentials(configuration)) return unavailable("mcp_project_credentials_unavailable");
  if (!server.sharedConfigEnvelope && authMode(configuration) !== "none") {
    return unavailable("mcp_runtime_unavailable");
  }
  const generation = server.sharedRuntime?.desiredRuntimeGeneration;
  if (!generation) return unavailable("mcp_runtime_unavailable");
  if (generation.sharedServerId !== server.id || generation.userServerId !== null) {
    return unavailable("mcp_runtime_stale");
  }
  if (generation.oauthConnectionId !== null ||
    generation.credentialSources.some((source) => source !== "shared")) {
    return unavailable("mcp_project_credentials_unavailable");
  }
  if (generation.revisionId !== server.activeRevisionId) return unavailable("mcp_revision_changed");
  const runtime = runtimeReadiness(generation.state, generation.errorCode);
  return {
    ...runtimeTimeouts(configuration),
    catalogTools: currentCatalogTools(
      server.activeRevision.validationEvidence,
      configuration,
      generation.inventory
    ),
    credentialSources: generation.credentialSources.filter(
      (source): source is "shared" => source === "shared"
    ),
    enabled: true,
    errorCode: runtime.errorCode,
    externalAccountLabel: null,
    fingerprint: generation.fingerprint,
    generationId: generation.id,
    inventory: generation.inventory,
    inventoryUpdatedAt: generation.inventoryUpdatedAt,
    namespace: server.namespace,
    readiness: runtime.readiness,
    revisionId: generation.revisionId,
    serverDescription: server.description,
    serverId: server.id,
    serverName: server.displayName
  };
}

async function filterRunPlanRecords(
  userId: string,
  records: McpRunPlanRecord[],
  client: PrismaClient
): Promise<McpRunPlanRecord[]> {
  if (!records.length) return records;
  const allowed = await loadMcpToolAccess(userId, records.map(({ serverId }) => serverId), client);
  return records.map((record) => ({
    ...record,
    catalogTools: record.catalogTools?.filter(({ name }) => allowed({ serverId: record.serverId, originalName: name })),
    // Filter the projection, never the shared generation's inventory. Preserve
    // malformed entries so the existing complete-inventory validator rejects them.
    inventory: isRecord(record.inventory) && Array.isArray(record.inventory.tools)
      ? { ...record.inventory, tools: record.inventory.tools.filter((tool) =>
          !isRecord(tool) || typeof tool.name !== "string" ||
          (record.catalogTools?.some((candidate) => candidate.name === tool.name) !== false &&
            allowed({ serverId: record.serverId, originalName: tool.name }))) }
      : record.inventory
  }));
}

export async function loadMcpRunPlanRecords(
  userId: string,
  client: PrismaClient = prisma
): Promise<McpRunPlanRecord[]> {
  const preferences = await client.mcpUserServer.findMany({
    select: runPlanPreferenceSelect,
    where: { enabled: true, userId }
  });
  return filterRunPlanRecords(userId, preferences
    .map(serializeRunPlanPreference)
    .sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId)), client);
}

export async function loadMcpCapabilityCatalog(
  userId: string,
  client: PrismaClient = prisma
): Promise<McpCapabilityCatalog> {
  return buildMcpCapabilityCatalog(await loadMcpRunPlanRecords(userId, client));
}

/** The Auto catalog and the personal servers it had to leave out, from one read. */
export async function loadMcpCapabilityCatalogWithOmissions(
  userId: string,
  client: PrismaClient = prisma
): Promise<Readonly<{ catalog: McpCapabilityCatalog; omitted: McpCatalogOmission[] }>> {
  const records = await loadMcpRunPlanRecords(userId, client);
  return { catalog: buildMcpCapabilityCatalog(records), omitted: mcpCatalogOmissions(records) };
}

/**
 * Exact-subset loader for Assistant allowlists. It intentionally includes the
 * runner's disabled preference rows so a requested-but-disabled server surfaces
 * as an unavailable record rather than silently disappearing; servers without
 * any preference row remain absent and fail the subset plan closed.
 */
export async function loadMcpRunPlanRecordsForServers(
  userId: string,
  serverIds: readonly string[],
  client: PrismaClient = prisma
): Promise<McpRunPlanRecord[]> {
  if (serverIds.length === 0) return [];
  const preferences = await client.mcpUserServer.findMany({
    select: runPlanPreferenceSelect,
    where: { serverId: { in: [...serverIds] }, userId }
  });
  return filterRunPlanRecords(userId, preferences
    .map(serializeRunPlanPreference)
    .sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId)), client);
}

export async function loadMcpRunPlanRecordsForProjectServers(
  userId: string,
  serverIds: readonly string[],
  client: PrismaClient = prisma
): Promise<McpRunPlanRecord[]> {
  const uniqueServerIds = [...new Set(serverIds)];
  if (uniqueServerIds.length === 0) return [];
  const servers = await client.mcpServer.findMany({
    select: projectRunServerSelect,
    where: { id: { in: uniqueServerIds } }
  });
  return filterRunPlanRecords(userId, servers
    .map(serializeProjectRunServer)
    .sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId)), client);
}

export function createPrismaMcpRunPlanLoader(client: PrismaClient = prisma) {
  return (userId: string, serverIds?: readonly string[]) =>
    serverIds
      ? loadMcpRunPlanRecordsForServers(userId, serverIds, client)
      : loadMcpRunPlanRecords(userId, client);
}

export function createPrismaMcpProjectRunPlanLoader(client: PrismaClient = prisma) {
  return (userId: string, serverIds: readonly string[]) => loadMcpRunPlanRecordsForProjectServers(userId, serverIds, client);
}

export function createPrismaMcpCapabilityCatalogLoader(client: PrismaClient = prisma) {
  return (userId: string) => loadMcpCapabilityCatalog(userId, client);
}

export function createPrismaMcpCapabilityCatalogWithOmissionsLoader(client: PrismaClient = prisma) {
  return (userId: string) => loadMcpCapabilityCatalogWithOmissions(userId, client);
}
