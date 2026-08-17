import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MCP_FIND_TOOLS_NAME,
  mcpFindToolsArguments,
  mergeMcpRunPlanSnapshots
} from "../mcp/discovery";
import { decodeMcpDiscoveryState } from "../mcp/discoveryState";
import type {
  McpDiscoveryState,
  McpRunPlanBinding,
  McpRunPlanSnapshot
} from "../mcp/runPlan";
import { insertAcceptedMcpRunBindings } from "./prismaRepositoryBindings";
import type { RunRepository } from "./runRepositoryContract";
import { json } from "./prismaRepositoryShared";
import { toolRunBudgetsForRequest } from "./toolBudgets";

type McpDiscoveryOperations = Pick<Required<RunRepository>, "appendMcpDiscoveryEpoch">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runPlanSnapshot(value: unknown): McpRunPlanSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 ||
    !Array.isArray(value.servers) || !Array.isArray(value.tools)) return undefined;
  return value as unknown as McpRunPlanSnapshot;
}

function addedSnapshotMatchesCatalog(
  discovery: McpDiscoveryState,
  snapshot: McpRunPlanSnapshot,
  maxResults: number
): boolean {
  const catalogTools = new Map(discovery.catalog.servers.flatMap((server) =>
    server.tools.map((tool) => [tool.namespacedName, {
      originalName: tool.originalName,
      revisionId: server.revisionId,
      serverId: server.serverId
    }] as const)
  ));
  const snapshotServers = new Map(snapshot.servers.map((server) => [server.serverId, server] as const));
  const usedServerIds = new Set(snapshot.tools.map((tool) => tool.serverId));
  if (snapshot.tools.length === 0) return snapshot.servers.length === 0;
  return snapshot.tools.length <= maxResults &&
    snapshotServers.size === snapshot.servers.length &&
    new Set(snapshot.tools.map((tool) => tool.namespacedName)).size === snapshot.tools.length &&
    usedServerIds.size === snapshot.servers.length &&
    snapshot.servers.every((server) => usedServerIds.has(server.serverId)) &&
    snapshot.tools.every((tool) => {
    const catalog = catalogTools.get(tool.namespacedName);
    const server = snapshotServers.get(tool.serverId);
    return Boolean(
      catalog && server &&
      catalog.originalName === tool.originalName &&
      catalog.serverId === tool.serverId &&
      catalog.revisionId === server.revisionId
    );
    });
}

export function createPrismaMcpDiscoveryOperations(
  client: PrismaClient
): McpDiscoveryOperations {
  return {
    appendMcpDiscoveryEpoch: async (input) => client.$transaction(async (tx) => {
      const [run] = await tx.$queryRaw<Array<{
        normalizedRequest: Prisma.JsonValue | null;
        status: string;
      }>>`
        SELECT "normalizedRequest", "status"
        FROM "ModelRun"
        WHERE "id" = ${input.runId}
          AND "userId" = ${input.userId}
        FOR UPDATE
      `;
      if (!run || !["queued", "streaming", "in_progress"].includes(run.status) ||
        !isRecord(run.normalizedRequest)) return null;
      const maxResults = toolRunBudgetsForRequest(run.normalizedRequest)
        .maxMcpToolsPerDiscovery;
      const currentDiscovery = decodeMcpDiscoveryState(
        run.normalizedRequest.mcpDiscovery,
        maxResults
      );
      if (!currentDiscovery ||
        !addedSnapshotMatchesCatalog(currentDiscovery, input.snapshot, maxResults)) {
        return null;
      }
      const catalogToolIds = new Set(currentDiscovery.catalog.servers.flatMap((server) =>
        server.tools.map((tool) => tool.namespacedName)
      ));
      if (input.toolIds.length > maxResults ||
        new Set(input.toolIds).size !== input.toolIds.length ||
        input.toolIds.some((toolId) => !catalogToolIds.has(toolId))) return null;
      const persistedCall = await tx.modelRunToolCall.findFirst({
        select: { arguments: true, roundIndex: true, toolName: true },
        where: { id: input.modelRunToolCallId, modelRunId: input.runId }
      });
      const persistedArguments = persistedCall && isRecord(persistedCall.arguments)
        ? mcpFindToolsArguments(persistedCall.arguments)
        : null;
      if (!persistedCall || persistedCall.toolName !== MCP_FIND_TOOLS_NAME ||
        persistedCall.roundIndex !== input.roundIndex ||
        persistedArguments?.goal !== input.goal) return null;
      const snapshotServers = new Map(
        input.snapshot.servers.map((server) => [server.serverId, server] as const)
      );
      const bindingServerIds = new Set(input.bindings.map((binding) => binding.serverId));
      if (input.bindings.length !== snapshotServers.size || input.bindings.some((binding) =>
        snapshotServers.get(binding.serverId)?.fingerprint !== binding.fingerprint) ||
        bindingServerIds.size !== snapshotServers.size ||
        [...snapshotServers.keys()].some((serverId) => !bindingServerIds.has(serverId))) {
        return null;
      }
      const currentSnapshot = runPlanSnapshot(run.normalizedRequest.mcp);
      const replay = currentDiscovery.epochs.find((epoch) =>
        epoch.modelRunToolCallId === input.modelRunToolCallId);
      if (replay) {
        return currentSnapshot && replay.goal === input.goal &&
          replay.roundIndex === input.roundIndex
          ? { discovery: currentDiscovery, snapshot: currentSnapshot }
          : null;
      }

      let merged: McpRunPlanSnapshot;
      try {
        merged = mergeMcpRunPlanSnapshots(currentSnapshot, input.snapshot);
      } catch {
        return null;
      }
      const addedToolIds = input.snapshot.tools.map((tool) => tool.namespacedName);
      const mergedToolIds = new Set(merged.tools.map((tool) => tool.namespacedName));
      if ((addedToolIds.length > 0 && (
        addedToolIds.length !== input.toolIds.length ||
        addedToolIds.some((toolId) => !input.toolIds.includes(toolId))
      )) || input.toolIds.some((toolId) => !mergedToolIds.has(toolId))) return null;
      const existingFingerprints = new Set((await tx.mcpRunBinding.findMany({
        select: { runtimeGenerationFingerprint: true },
        where: { modelRunId: input.runId }
      })).map((binding) => binding.runtimeGenerationFingerprint));
      const newBindings: McpRunPlanBinding[] = input.bindings
        .filter((binding) => !existingFingerprints.has(binding.fingerprint))
        .map((binding) => ({ ...binding }));
      await insertAcceptedMcpRunBindings(tx, {
        bindings: newBindings,
        runId: input.runId,
        userId: input.userId
      });
      const nextDiscovery: McpDiscoveryState = {
        ...currentDiscovery,
        epochs: [
          ...currentDiscovery.epochs,
          {
            epoch: currentDiscovery.epochs.length + 1,
            goal: input.goal,
            modelRunToolCallId: input.modelRunToolCallId,
            roundIndex: input.roundIndex,
            toolIds: [...input.toolIds]
          }
        ]
      };
      await tx.modelRun.update({
        data: {
          normalizedRequest: json({
            ...run.normalizedRequest,
            mcp: merged,
            mcpDiscovery: nextDiscovery
          })
        },
        where: { id: input.runId }
      });
      return { discovery: nextDiscovery, snapshot: merged };
    })
  };
}
