import type { PrismaClient } from "@prisma/client";
import { namespacedMcpToolName, prepareMcpRunPlan } from "@/lib/server/mcp/runPlan";
import { loadMcpCapabilityCatalog, loadMcpRunPlanRecordsForServers } from "@/lib/server/mcp/runPlanRepository";

/**
 * One owner's personal MCP server as the run-plan loader reads it: a ready
 * generation holding the full upstream inventory, plus the owner's mutable
 * switched-off tools. Catalogs and plans go through the real projection, so a
 * dispatch site sees exactly what Auto, Load all and the plan rebuild see.
 */
export function personalMcpFixture(input: Readonly<{
  /** The accepted runtime identity; harnesses that derive generation ids from it can match. */
  fingerprint?: string;
  generationId?: string;
  toolNames: readonly string[];
  userId?: string;
}>) {
  const userId = input.userId ?? "user-1";
  const fingerprint = input.fingerprint ?? "personal-fingerprint";
  const generationId = input.generationId ?? `generation-${fingerprint}`;
  const serverId = "personal-server";
  const namespace = "personal_tools";
  const inventoryUpdatedAt = new Date();
  const disabled = new Set<string>();
  const tools = input.toolNames.map((name) => ({
    definitionHash: "c".repeat(64), description: `${name} tool`, inputSchema: { type: "object" }, name
  }));
  const preference = () => ({
    desiredRuntimeGeneration: {
      credentialSources: [], errorCode: null, externalAccountLabel: null, fingerprint,
      id: generationId, inventory: { exclusions: [], tools, version: 1 }, inventoryUpdatedAt,
      oauthConnectionId: null, revisionId: "personal-revision", state: "ready", userServerId: "personal-preference"
    },
    desiredRuntimeGenerationId: generationId,
    discoveredInventory: null,
    discoveredOAuthConnectionId: null,
    discoveredRevisionId: null,
    enabled: true,
    id: "personal-preference",
    runtimeGenerations: [],
    server: {
      activeRevision: { configuration: { auth: { mode: "none" } }, validationEvidence: { toolInventory: [] } },
      activeRevisionId: "personal-revision", archivedAt: null, description: "Personal tools", displayName: "Personal tools",
      enabled: true, grants: [], id: serverId, namespace, oauthConnections: [], ownerUserId: userId
    },
    user: { groups: [], status: "active" },
    userDisabledToolNames: [...disabled].sort(),
    userId
  });
  const client = {
    mcpToolAccessPolicy: { findMany: async () => [] },
    mcpUserServer: { findMany: async () => [preference()] },
    user: { findUnique: async () => ({ groups: [], status: "active" }) }
  } as unknown as PrismaClient;
  return {
    catalog: () => loadMcpCapabilityCatalog(userId, client),
    fingerprint,
    generationId,
    namespacedName: (name: string) => namespacedMcpToolName(namespace, name),
    /** The plan every dispatch site rebuilds before calling, or Load all without a tool subset. */
    prepare: (allowedToolNames?: readonly string[]) => prepareMcpRunPlan({
      allowedServerIds: [serverId],
      ...(allowedToolNames ? { allowedToolNames } : {}),
      isGenerationLive: () => true,
      load: () => loadMcpRunPlanRecordsForServers(userId, [serverId], client)
    }),
    serverId,
    switchTool(name: string, enabled: boolean) {
      if (enabled) disabled.delete(name);
      else disabled.add(name);
    },
    userId
  };
}
