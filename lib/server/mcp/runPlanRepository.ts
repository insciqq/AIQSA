import { Prisma, type PrismaClient } from "@prisma/client";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { prisma } from "@/lib/server/prisma";
import type { McpRunPlanRecord } from "./runPlan";

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
      activeRevisionId: true,
      archivedAt: true,
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

export function createPrismaMcpRunPlanLoader(client: PrismaClient = prisma) {
  return (userId: string) => loadMcpRunPlanRecords(userId, client);
}
