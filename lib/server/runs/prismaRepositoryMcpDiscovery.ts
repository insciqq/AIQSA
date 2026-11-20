import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MCP_FIND_TOOLS_NAME,
  mcpFindToolsArguments,
  mergeMcpRunPlanSnapshots
} from "../mcp/discovery";
import { decodeMcpDiscoveryState, decodeMcpDiscoveryUnavailable } from "../mcp/discoveryState";
import type {
  McpDiscoveryState,
  McpRunPlanBinding,
  McpRunPlanSnapshot
} from "../mcp/runPlan";
import { insertAcceptedMcpRunBindings } from "./prismaRepositoryBindings";
import type { RunRepository } from "./runRepositoryContract";
import { isPrismaSerializationConflict, json } from "./prismaRepositoryShared";
import { toolRunBudgetsForRequest } from "./toolBudgets";

type McpDiscoveryOperations = Pick<Required<RunRepository>, "appendMcpDiscoveryEpoch">;
type EpochInput = Parameters<McpDiscoveryOperations["appendMcpDiscoveryEpoch"]>[0];
type EpochResult = Awaited<ReturnType<McpDiscoveryOperations["appendMcpDiscoveryEpoch"]>>;

/**
 * Attempts of one epoch whose transaction the database rolled back for a conflict (`epochConflict`). Nothing of a
 * rolled-back attempt stays, so the next one plans again on the run as it then stands, and a replay stays a replay.
 */
const EPOCH_ATTEMPTS = 3;

/** A deadlock, a serialization failure or a binding row of the run that another writer committed first. */
function epochConflict(error: unknown): boolean {
  if (isPrismaSerializationConflict(error)) return true;
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" ||
    error.code === "P2010" && isRecord(error.meta) && error.meta.code === "23505");
}

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

/**
 * Lock order of a discovery epoch (2026-11-20): it locks the run whose agent called `find_tools`, `FOR NO KEY UPDATE` like
 * other run locks (`subagentBackground/store.ts`), before anything else, and then takes only what its new binding rows
 * need: a foreign-key KEY SHARE of that run and of each runtime generation, which only a deletion or a key change
 * conflicts with, and that run's unique-index entries in fingerprint order (`insertAcceptedMcpRunBindings`), which nothing
 * writes without the run's lock but the transaction that creates the run. It never locks or writes another run: a
 * background sub-agent's run binds what its own `find_tools` loads on itself, and its registry and saved results read
 * those rows beside the main-agent run's (`mcpBindingRunIds` in `lib/server/subagents/nesting.ts`). Binding on the
 * main-agent run instead closed cycles with an image or a computer file the main agent publishes (its run, then the
 * chat), with chat-first settlements of the sub-agent's run, and with the main agent's discovery of the same server.
 * Discoveries of one run (the main agent and its foreground sub-agents, or a background sub-agent and its foreground
 * children) queue on its lock, and a later one plans on what the earlier committed.
 */
async function appendEpoch(tx: Prisma.TransactionClient, input: EpochInput): Promise<EpochResult> {
  const [run] = await tx.$queryRaw<Array<{
    normalizedRequest: Prisma.JsonValue | null;
    status: string;
  }>>`
    SELECT run."normalizedRequest", run."status"
    FROM "ModelRun" AS run
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
    FOR NO KEY UPDATE OF run
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
  // A server the call could not load is never also loaded by it.
  const unavailable = decodeMcpDiscoveryUnavailable(input.unavailable ?? [],
    new Set(currentDiscovery.catalog.servers.map((server) => server.serverId)), maxResults);
  if (!unavailable || unavailable.some((server) =>
    input.snapshot.servers.some((loaded) => loaded.serverId === server.serverId))) return null;
  const persistedCall = await tx.modelRunToolCall.findFirst({
    select: { arguments: true, roundIndex: true, toolName: true },
    where: { id: input.modelRunToolCallId, modelRunId: input.runId }
  });
  const persistedArguments = persistedCall && isRecord(persistedCall.arguments)
    ? mcpFindToolsArguments(persistedCall.arguments)
    : null;
  if (!persistedCall || persistedCall.toolName !== MCP_FIND_TOOLS_NAME ||
    persistedCall.roundIndex !== input.roundIndex ||
    persistedArguments?.query !== input.goal) return null;
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
  // The epoch lists newly loaded and already-active matches; only the
  // newly loaded ones arrive in the added snapshot.
  const addedToolIds = input.snapshot.tools.map((tool) => tool.namespacedName);
  const mergedToolIds = new Set(merged.tools.map((tool) => tool.namespacedName));
  if (addedToolIds.some((toolId) => !input.toolIds.includes(toolId)) ||
    input.toolIds.some((toolId) => !mergedToolIds.has(toolId))) return null;
  const existingFingerprints = new Set((await tx.mcpRunBinding.findMany({
    select: { runtimeGenerationFingerprint: true },
    where: { modelRunId: input.runId }
  })).map((binding) => binding.runtimeGenerationFingerprint));
  const newBindings: McpRunPlanBinding[] = input.bindings
    .filter((binding) => !existingFingerprints.has(binding.fingerprint))
    .map((binding) => ({ ...binding }));
  await insertAcceptedMcpRunBindings(tx, {
    bindings: newBindings,
    tools: merged.tools.filter((tool) => input.toolIds.includes(tool.namespacedName)),
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
        toolIds: [...input.toolIds],
        ...(unavailable.length ? { unavailable } : {})
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
}

export function createPrismaMcpDiscoveryOperations(
  client: PrismaClient
): McpDiscoveryOperations {
  return {
    appendMcpDiscoveryEpoch: async (input) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await client.$transaction((tx) => appendEpoch(tx, input));
        } catch (error) {
          if (attempt >= EPOCH_ATTEMPTS || !epochConflict(error)) throw error;
        }
      }
    }
  };
}
