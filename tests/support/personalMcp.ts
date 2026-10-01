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
  /** The connection signs in through OAuth, so its owner can lose that authorization. */
  oauth?: boolean;
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
  const definitions = new Map(input.toolNames.map((name) => [name, "c".repeat(64)]));
  const connection = { authorized: true, deletedAt: null as Date | null, enabled: true };
  const tools = () => input.toolNames.map((name) => ({
    definitionHash: definitions.get(name)!, description: `${name} tool`, inputSchema: { type: "object" }, name
  }));
  const preference = () => ({
    desiredRuntimeGeneration: {
      credentialSources: input.oauth ? ["oauth"] : [], errorCode: null, externalAccountLabel: null, fingerprint,
      id: generationId, inventory: { exclusions: [], tools: tools(), version: 1 }, inventoryUpdatedAt,
      oauthConnectionId: input.oauth ? "personal-oauth" : null, revisionId: "personal-revision", state: "ready",
      userServerId: "personal-preference"
    },
    desiredRuntimeGenerationId: generationId,
    discoveredInventory: null,
    discoveredOAuthConnectionId: null,
    discoveredRevisionId: null,
    enabled: connection.enabled && !connection.deletedAt,
    id: "personal-preference",
    runtimeGenerations: [],
    server: {
      activeRevision: {
        configuration: { auth: { mode: input.oauth ? "oauth" : "none" } },
        validationEvidence: { toolInventory: [] }
      },
      activeRevisionId: "personal-revision", archivedAt: connection.deletedAt, description: "Personal tools",
      displayName: "Personal tools", enabled: !connection.deletedAt, grants: [], id: serverId, namespace,
      oauthConnections: input.oauth ? [{
        disconnectRequestedAt: connection.deletedAt,
        id: "personal-oauth",
        state: connection.deletedAt ? "disconnecting" : connection.authorized ? "ready" : "reauthorization_required",
        userId
      }] : [],
      ownerUserId: userId
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
    /** The runtime applied a new upstream definition of this tool to the same generation. */
    changeDefinition(name: string) {
      definitions.set(name, "d".repeat(64));
    },
    /** The owner deletes the connection: the server is archived and its OAuth token revoked. */
    delete() {
      connection.deletedAt = new Date();
    },
    fingerprint,
    generationId,
    /** The OAuth token can no longer be refreshed and needs the owner to sign in again. */
    loseAuthorization() {
      if (!input.oauth) throw new Error("personal_fixture_without_oauth");
      connection.authorized = false;
    },
    namespacedName: (name: string) => namespacedMcpToolName(namespace, name),
    /** The plan every dispatch site rebuilds before calling, or Load all without a tool subset. */
    prepare: (allowedToolNames?: readonly string[]) => prepareMcpRunPlan({
      allowedServerIds: [serverId],
      ...(allowedToolNames ? { allowedToolNames } : {}),
      isGenerationLive: () => true,
      load: () => loadMcpRunPlanRecordsForServers(userId, [serverId], client)
    }),
    serverId,
    /** The owner switches the whole connection off or on. */
    setEnabled(enabled: boolean) {
      connection.enabled = enabled;
    },
    switchTool(name: string, enabled: boolean) {
      if (enabled) disabled.delete(name);
      else disabled.add(name);
    },
    userId
  };
}
