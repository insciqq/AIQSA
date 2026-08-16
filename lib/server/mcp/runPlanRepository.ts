import { Prisma, type PrismaClient } from "@prisma/client";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import {
  buildMcpCapabilityCatalog,
  type McpCapabilityCatalog,
  type McpRunPlanRecord
} from "./runPlan";

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
      revisionId: true,
      state: true,
      userServerId: true
    }
  },
  desiredRuntimeGenerationId: true,
  enabled: true,
  id: true,
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
      namespace: true
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

function revisionCatalogTools(
  validationEvidence: unknown,
  configuration: unknown
): { description: string | null; name: string; title?: string }[] {
  if (!isRecord(validationEvidence) || !Array.isArray(validationEvidence.toolInventory)) return [];
  const disabled = new Set(
    isRecord(configuration) && Array.isArray(configuration.disabledToolNames)
      ? configuration.disabledToolNames.filter((name): name is string => typeof name === "string")
      : []
  );
  return validationEvidence.toolInventory.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name.trim() ||
      disabled.has(candidate.name) ||
      !(candidate.description === null || typeof candidate.description === "string")) return [];
    return [{
      description: candidate.description as string | null,
      name: candidate.name,
      ...(typeof candidate.title === "string" && candidate.title.trim()
        ? { title: candidate.title.trim() }
        : {})
    }];
  });
}

function serializeRunPlanPreference(preference: RunPlanPreferenceRecord): McpRunPlanRecord {
  const groupIds = new Set(preference.user.groups.map((membership) => membership.groupId));
  const canUse = preference.server.grants.some((grant) => grant.canUse && (
    grant.userId === preference.userId || Boolean(grant.groupId && groupIds.has(grant.groupId))
  ));
  if (preference.user.status !== "active" || !canUse) {
    return inaccessibleRecord(preference, "mcp_access_revoked");
  }
  if (!preference.server.enabled || preference.server.archivedAt || !preference.server.activeRevisionId) {
    return inaccessibleRecord(preference, "mcp_server_unavailable");
  }

  const generation = preference.desiredRuntimeGeneration;
  if (!generation) {
    return {
      ...inaccessibleRecord(
        preference,
        preference.desiredRuntimeGenerationId ? "mcp_runtime_stale" : "mcp_runtime_pending"
      ),
      catalogTools: revisionCatalogTools(
        preference.server.activeRevision?.validationEvidence,
        preference.server.activeRevision?.configuration
      ),
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
    catalogTools: revisionCatalogTools(
      preference.server.activeRevision?.validationEvidence,
      preference.server.activeRevision?.configuration
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
    serverName: preference.server.displayName
  };
}

export async function loadMcpRunPlanRecords(
  userId: string,
  client: PrismaClient = prisma
): Promise<McpRunPlanRecord[]> {
  const preferences = await client.mcpUserServer.findMany({
    select: runPlanPreferenceSelect,
    where: { enabled: true, userId }
  });
  return preferences
    .map(serializeRunPlanPreference)
    .sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId));
}

export async function loadMcpCapabilityCatalog(
  userId: string,
  client: PrismaClient = prisma
): Promise<McpCapabilityCatalog> {
  return buildMcpCapabilityCatalog(await loadMcpRunPlanRecords(userId, client));
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
  return preferences
    .map(serializeRunPlanPreference)
    .sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId));
}

export function createPrismaMcpRunPlanLoader(client: PrismaClient = prisma) {
  return (userId: string, serverIds?: readonly string[]) =>
    serverIds
      ? loadMcpRunPlanRecordsForServers(userId, serverIds, client)
      : loadMcpRunPlanRecords(userId, client);
}

export function createPrismaMcpCapabilityCatalogLoader(client: PrismaClient = prisma) {
  return (userId: string) => loadMcpCapabilityCatalog(userId, client);
}
