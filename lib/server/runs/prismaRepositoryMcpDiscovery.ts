import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MCP_FIND_TOOLS_NAME,
  mcpFindToolsArguments,
  mergeMcpRunPlanSnapshots
} from "../mcp/discovery";
import { decodeMcpDiscoveryState, decodeMcpDiscoveryUnavailable } from "../mcp/discoveryState";
import { runBindingOwner } from "../subagents/nesting";
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

type EpochInput = Parameters<McpDiscoveryOperations["appendMcpDiscoveryEpoch"]>[0];
type EpochResult = Readonly<{ discovery: McpDiscoveryState; snapshot: McpRunPlanSnapshot }>;
type EpochRun = Readonly<{ chatId: string; normalizedRequest: Prisma.JsonValue | null; status: string }>;
type EpochPlan =
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "replay"; result: EpochResult }>
  | Readonly<{ kind: "append"; merged: McpRunPlanSnapshot; next: McpDiscoveryState; request: Record<string, unknown> }>;

/** A background caller's run moved between its first read and its lock: what it bound on the owner run goes back. */
class EpochRunMoved extends Error {}

const REFUSED: EpochPlan = { kind: "refused" };

function readEpochRun(tx: Prisma.TransactionClient, input: EpochInput, lock: boolean): Promise<EpochRun[]> {
  return tx.$queryRaw<EpochRun[]>`
    SELECT run."chatId", run."normalizedRequest", run."status"
    FROM "ModelRun" AS run
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
    ${lock ? Prisma.sql`FOR UPDATE OF run` : Prisma.empty}
  `;
}

/** Every check of an epoch on this state of its run, and what it would write; it writes nothing. */
async function planEpoch(tx: Prisma.TransactionClient, run: EpochRun | undefined, input: EpochInput): Promise<EpochPlan> {
  if (!run || !["queued", "streaming", "in_progress"].includes(run.status) ||
    !isRecord(run.normalizedRequest)) return REFUSED;
  const maxResults = toolRunBudgetsForRequest(run.normalizedRequest)
    .maxMcpToolsPerDiscovery;
  const currentDiscovery = decodeMcpDiscoveryState(
    run.normalizedRequest.mcpDiscovery,
    maxResults
  );
  if (!currentDiscovery ||
    !addedSnapshotMatchesCatalog(currentDiscovery, input.snapshot, maxResults)) {
    return REFUSED;
  }
  const catalogToolIds = new Set(currentDiscovery.catalog.servers.flatMap((server) =>
    server.tools.map((tool) => tool.namespacedName)
  ));
  if (input.toolIds.length > maxResults ||
    new Set(input.toolIds).size !== input.toolIds.length ||
    input.toolIds.some((toolId) => !catalogToolIds.has(toolId))) return REFUSED;
  // A server the call could not load is never also loaded by it.
  const unavailable = decodeMcpDiscoveryUnavailable(input.unavailable ?? [],
    new Set(currentDiscovery.catalog.servers.map((server) => server.serverId)), maxResults);
  if (!unavailable || unavailable.some((server) =>
    input.snapshot.servers.some((loaded) => loaded.serverId === server.serverId))) return REFUSED;
  const persistedCall = await tx.modelRunToolCall.findFirst({
    select: { arguments: true, roundIndex: true, toolName: true },
    where: { id: input.modelRunToolCallId, modelRunId: input.runId }
  });
  const persistedArguments = persistedCall && isRecord(persistedCall.arguments)
    ? mcpFindToolsArguments(persistedCall.arguments)
    : null;
  if (!persistedCall || persistedCall.toolName !== MCP_FIND_TOOLS_NAME ||
    persistedCall.roundIndex !== input.roundIndex ||
    persistedArguments?.query !== input.goal) return REFUSED;
  const snapshotServers = new Map(
    input.snapshot.servers.map((server) => [server.serverId, server] as const)
  );
  const bindingServerIds = new Set(input.bindings.map((binding) => binding.serverId));
  if (input.bindings.length !== snapshotServers.size || input.bindings.some((binding) =>
    snapshotServers.get(binding.serverId)?.fingerprint !== binding.fingerprint) ||
    bindingServerIds.size !== snapshotServers.size ||
    [...snapshotServers.keys()].some((serverId) => !bindingServerIds.has(serverId))) {
    return REFUSED;
  }
  const currentSnapshot = runPlanSnapshot(run.normalizedRequest.mcp);
  const replay = currentDiscovery.epochs.find((epoch) =>
    epoch.modelRunToolCallId === input.modelRunToolCallId);
  if (replay) {
    return currentSnapshot && replay.goal === input.goal &&
      replay.roundIndex === input.roundIndex
      ? { kind: "replay", result: { discovery: currentDiscovery, snapshot: currentSnapshot } }
      : REFUSED;
  }

  let merged: McpRunPlanSnapshot;
  try {
    merged = mergeMcpRunPlanSnapshots(currentSnapshot, input.snapshot);
  } catch {
    return REFUSED;
  }
  // The epoch lists newly loaded and already-active matches; only the
  // newly loaded ones arrive in the added snapshot.
  const addedToolIds = input.snapshot.tools.map((tool) => tool.namespacedName);
  const mergedToolIds = new Set(merged.tools.map((tool) => tool.namespacedName));
  if (addedToolIds.some((toolId) => !input.toolIds.includes(toolId)) ||
    input.toolIds.some((toolId) => !mergedToolIds.has(toolId))) return REFUSED;
  const next: McpDiscoveryState = {
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
  return { kind: "append", merged, next, request: run.normalizedRequest };
}

/**
 * Binds an epoch's servers on `runId`, the run that owns the caller's bindings. A binding the run already holds is
 * skipped, and one bound meanwhile by another agent of the same answer is its own insert's no-op: the run's unique key,
 * not a lock, decides that race (`insertAcceptedMcpRunBindings`).
 */
async function bindEpoch(tx: Prisma.TransactionClient, runId: string, plan: Extract<EpochPlan, { kind: "append" }>,
  input: EpochInput): Promise<void> {
  const existingFingerprints = new Set((await tx.mcpRunBinding.findMany({
    select: { runtimeGenerationFingerprint: true },
    where: { modelRunId: runId }
  })).map((binding) => binding.runtimeGenerationFingerprint));
  const newBindings: McpRunPlanBinding[] = input.bindings
    .filter((binding) => !existingFingerprints.has(binding.fingerprint))
    .map((binding) => ({ ...binding }));
  await insertAcceptedMcpRunBindings(tx, {
    bindings: newBindings,
    tools: plan.merged.tools.filter((tool) => input.toolIds.includes(tool.namespacedName)),
    runId,
    userId: input.userId
  });
}

export function createPrismaMcpDiscoveryOperations(
  client: PrismaClient
): McpDiscoveryOperations {
  return {
    /**
     * The epoch is the calling run's, with its call; its binding rows go to the run that owns the caller's bindings
     * (`runBindingOwner`). A background sub-agent's run holds none of its own: its registry and its saved results read
     * the main-agent run's, so a server only it loaded was never bound there and its tools could not be called. Such a
     * caller binds there before it holds its own run, so it never waits for the main-agent run while holding a
     * sub-agent's (a binding's key share of that run waits for an image or a computer file the main agent publishes,
     * which waits for the chat a sub-agent's settlement holds while it waits for the sub-agent's run); then it holds its
     * own run and goes on only if nothing of it moved since it read it.
     */
    appendMcpDiscoveryEpoch: async (input) => {
      try {
        return await client.$transaction(async (tx): Promise<EpochResult | null> => {
          const [seen] = await readEpochRun(tx, input, false);
          if (!seen) return null;
          const owner = await runBindingOwner(tx, { chatId: seen.chatId, runId: input.runId, userId: input.userId });
          if (!owner) return null;
          const elsewhere = owner.runId !== input.runId;
          const early = elsewhere ? await planEpoch(tx, seen, input) : null;
          if (early?.kind === "append") await bindEpoch(tx, owner.runId, early, input);
          const [run] = await readEpochRun(tx, input, true);
          if (early && JSON.stringify([run?.status, run?.normalizedRequest]) !==
            JSON.stringify([seen.status, seen.normalizedRequest])) throw new EpochRunMoved();
          const plan = await planEpoch(tx, run, input);
          if (early && early.kind !== plan.kind) throw new EpochRunMoved();
          if (plan.kind === "refused") return null;
          if (plan.kind === "replay") return plan.result;
          if (!elsewhere) await bindEpoch(tx, input.runId, plan, input);
          await tx.modelRun.update({
            data: {
              normalizedRequest: json({
                ...plan.request,
                mcp: plan.merged,
                mcpDiscovery: plan.next
              })
            },
            where: { id: input.runId }
          });
          return { discovery: plan.next, snapshot: plan.merged };
        });
      } catch (error) {
        if (error instanceof EpochRunMoved) return null;
        throw error;
      }
    }
  };
}
