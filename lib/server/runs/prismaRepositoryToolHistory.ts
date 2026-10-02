import { Prisma, type PrismaClient } from "@prisma/client";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { canAccessSearchStrategy } from "../auth/entitlements";
import { acceptedMcpCallIdentity, canReadAcceptedMcpCall, mcpDetailRecord as record,
  type AcceptedMcpCallIdentity } from "../mcp/callDetailsAuthority";
import { mcpCallRedactionEvidence, type McpRedactionEvidence } from "../mcp/callDetailsRedaction";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import { resolveChatAccess } from "../projects/access";
import { decodeToolObservationSourceBinding } from "../toolObservations/contract";
import { branchPathMessageIds, observationRunAuthority, runOnBranchPath } from "../toolObservations/repository";
import { activeModelRunStatuses } from "./prismaRepositoryShared";
import type { ToolHistoryProjection } from "./toolHistory";
import {
  TOOL_HISTORY_LIMITS,
  TOOL_HISTORY_VERSION,
  toolCallIdFromRef,
  toolCallRef,
  toolHistoryDigest,
  type ToolHistorySnapshot,
  type ToolHistoryTurn
} from "./toolHistoryContract";
import {
  isToolHistoryReaderName,
  toolHistoryBlock,
  toolHistoryKind,
  toolHistoryRecord,
  type ToolCallFacts,
  type ToolHistoryRecord
} from "./toolHistoryRecords";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";

/** Who reads a branch's call history: a live or recovering run (the call
 * reader, a run's records), or an admission that has no run yet. */
export type ToolHistoryActor =
  | Readonly<{ runId: string; userId: string }>
  | Readonly<{ chatId: string; leafMessageId: string | null; userId: string }>;

/** The reading side every check uses: the reader's chat, Project, branch and
 * own run. Calls of other chats, other edits and ineligible runs never pass. */
type ReadingContext = Readonly<{
  chatId: string;
  /** The user message the reader answers (earlier attempts of it are the
   * current turn's record), or null for a new message. */
  currentUserMessageId: string | null;
  pathIds: ReadonlySet<string>;
  projectId: string | null;
  retentionExpired: boolean;
  runId: string | null;
  userId: string;
}>;

class ToolHistoryUnavailable extends Error {
  constructor() { super("tool_history_unavailable"); this.name = "ToolHistoryUnavailable"; }
}

const MANAGED_AGENT_EXEC = namespacedWorkspaceToolName("sandbox_exec_start");

async function readingContext(tx: Prisma.TransactionClient, actor: ToolHistoryActor): Promise<ReadingContext> {
  let chatId: string;
  let leafMessageId: string | null;
  let runId: string | null = null;
  let currentUserMessageId: string | null = null;
  if ("runId" in actor) {
    const run = await observationRunAuthority(tx, actor).catch(() => { throw new ToolHistoryUnavailable(); });
    chatId = run.chatId;
    leafMessageId = run.assistantMessageId;
    runId = run.id;
    currentUserMessageId = run.userMessageId;
  } else {
    if (!await resolveChatAccess(tx, { chatId: actor.chatId, userId: actor.userId })) throw new ToolHistoryUnavailable();
    chatId = actor.chatId;
    leafMessageId = actor.leafMessageId;
    // A regeneration admits under its own user message; a send under the
    // previous answer, whose new message has no attempts yet.
    const leaf = leafMessageId ? await tx.message.findFirst({ where: { chatId, id: leafMessageId }, select: { role: true } }) : null;
    currentUserMessageId = leaf?.role === "user" ? leafMessageId : null;
  }
  const chat = await tx.chat.findUnique({ where: { id: chatId }, select: { archived: true, permanentDeletionAt: true,
    projectId: true, memoryMode: true, temporaryRetentionDeadline: true } });
  if (!chat || chat.archived || chat.permanentDeletionAt) throw new ToolHistoryUnavailable();
  return {
    chatId, currentUserMessageId, projectId: chat.projectId, runId, userId: actor.userId,
    pathIds: leafMessageId ? await branchPathMessageIds(tx, chatId, leafMessageId) : new Set<string>(),
    retentionExpired: chat.memoryMode === "TEMPORARY" && chat.temporaryRetentionDeadline !== null &&
      chat.temporaryRetentionDeadline <= new Date()
  };
}

/** Everything but the saved values: identity, state, receipts, observation
 * and the owning run. Small for any call. */
const callHeadSelect = {
  id: true, modelRunId: true, toolName: true, providerCallId: true, roundIndex: true, ordinal: true, state: true,
  startedAt: true, workspaceRunBindingId: true,
  mcpRunBinding: { select: { modelRunId: true, runtimeGenerationFingerprint: true, runtimeGenerationId: true } },
  observation: { select: { id: true, state: true, formatVersion: true, sourceKind: true, executionOutcome: true,
    projection: true, sourceBinding: true, modelRunId: true } },
  memoryToolEgressReceipts: { select: { dispatchState: true, errorCode: true } },
  modelRun: { select: { id: true, chatId: true, userMessageId: true, assistantMessageId: true, status: true } }
} satisfies Prisma.ModelRunToolCallSelect;

type CallHead = Prisma.ModelRunToolCallGetPayload<{ select: typeof callHeadSelect }>;

/** The saved values a record may excerpt: whole up to the projection bound,
 * else only their size and the result's envelope. */
type CallValues = Readonly<{
  arguments: unknown;
  result: unknown;
  omittedArgumentsBytes?: number;
  omittedResultBytes?: number;
}>;

type LoadedCall = CallHead & CallValues;

type AcceptedRun = Readonly<{
  agent: boolean;
  agentMcpTools: ReadonlyMap<string, Readonly<{ identity: AcceptedMcpCallIdentity; originalName: string; serverName: string }>>;
  eligible: boolean;
  normalizedRequest: Record<string, unknown>;
}>;

/** Only the accepted request parts that classify a call: never message bodies,
 * prompts or the continuation. */
async function acceptedRuns(tx: Prisma.TransactionClient, runIds: readonly string[]): Promise<Map<string, AcceptedRun>> {
  const runs = new Map<string, AcceptedRun>();
  if (runIds.length === 0) return runs;
  const rows = await tx.$queryRaw<Array<{
    id: string; mcp: unknown; catalog: unknown; searchPlan: unknown; workspace: boolean | null; image: boolean | null;
    agent: boolean | null; historyVersion: string | null;
  }>>`SELECT r."id",
      r."normalizedRequest" -> 'mcp' AS "mcp",
      r."normalizedRequest" -> 'mcpDiscovery' -> 'catalog' AS "catalog",
      r."normalizedRequest" -> 'searchPlan' AS "searchPlan",
      (r."normalizedRequest" -> 'workspace' ->> 'enabled') = 'true' AS "workspace",
      (r."normalizedRequest" -> 'imagePlan') IS NOT NULL AS "image",
      (r."normalizedRequest" -> 'agent') IS NOT NULL AS "agent",
      r."normalizedRequest" -> 'toolHistory' ->> 'version' AS "historyVersion"
    FROM "ModelRun" r WHERE r."id" IN (${Prisma.join([...runIds])})`;
  const agentIds = rows.filter(row => row.agent).map(row => row.id);
  const agentTools = agentIds.length ? await tx.agentMcpTool.findMany({ where: { modelRunId: { in: agentIds } },
    select: { modelRunId: true, toolId: true, snapshot: true } }) : [];
  for (const row of rows) {
    const tools = new Map<string, Readonly<{ identity: AcceptedMcpCallIdentity; originalName: string; serverName: string }>>();
    for (const tool of agentTools.filter(entry => entry.modelRunId === row.id)) {
      const snapshot = tool.snapshot as unknown as McpRunPlanSnapshot;
      const route = record(snapshot) ? resolveMcpRunTool(snapshot, tool.toolId) : null;
      const server = route && snapshot.servers.find(entry => entry.serverId === route.serverId);
      if (!route || !server) continue;
      tools.set(tool.toolId, { identity: { serverId: route.serverId, originalName: route.originalName,
        revisionId: server.revisionId, fingerprint: route.fingerprint }, originalName: route.originalName, serverName: server.serverName });
    }
    runs.set(row.id, {
      agent: row.agent === true,
      agentMcpTools: tools,
      eligible: row.historyVersion === String(TOOL_HISTORY_VERSION),
      normalizedRequest: {
        ...(row.mcp !== null ? { mcp: row.mcp } : {}),
        ...(row.catalog !== null ? { mcpDiscovery: { catalog: row.catalog } } : {}),
        ...(row.searchPlan !== null ? { searchPlan: row.searchPlan } : {}),
        ...(row.workspace ? { workspace: { enabled: true } } : {}),
        ...(row.image ? { imagePlan: {} } : {}),
        ...(row.agent ? { agent: {} } : {})
      }
    });
  }
  return runs;
}

/** Memoized per reading context: authority and redaction evidence never
 * change within one projection, and every call of a server shares them. */
function mcpAuthority(tx: Prisma.TransactionClient, context: ReadingContext) {
  const readable = new Map<string, Promise<boolean>>();
  const evidence = new Map<string, Promise<McpRedactionEvidence>>();
  return {
    readable(identity: AcceptedMcpCallIdentity) {
      const key = `${identity.serverId}\u0000${identity.originalName}`;
      let value = readable.get(key);
      if (!value) {
        value = canReadAcceptedMcpCall(tx, { ...identity, projectId: context.projectId, userId: context.userId });
        readable.set(key, value);
      }
      return value;
    },
    redaction(identity: AcceptedMcpCallIdentity, generationId: string | null) {
      const key = `${identity.serverId}\u0000${identity.revisionId}\u0000${identity.fingerprint}\u0000${generationId ?? ""}`;
      let value = evidence.get(key);
      if (!value) {
        value = mcpCallRedactionEvidence(tx, identity, generationId, context.userId, context.projectId);
        evidence.set(key, value);
      }
      return value;
    }
  };
}

function observationFact(call: CallHead, identity: AcceptedMcpCallIdentity | null): ToolCallFacts["observation"] {
  const observation = call.observation;
  if (!observation || observation.modelRunId !== call.modelRunId) return null;
  const binding = identity ? decodeToolObservationSourceBinding(observation.sourceBinding, "mcp") : null;
  // An MCP original belongs to this exact accepted identity, as the
  // initiator's display requires; anything else is never offered.
  const matches = !identity || binding?.source === "mcp" && binding.fingerprint === identity.fingerprint &&
    binding.serverId === identity.serverId && binding.revisionId === identity.revisionId &&
    binding.originalName === identity.originalName;
  const ready = observation.state === "READY" && observation.formatVersion === 1 && matches &&
    ["complete", "error"].includes(call.state);
  const projection = record(observation.projection) ? observation.projection : null;
  return {
    handle: ready ? `tor1_${observation.id}` : null,
    executionOutcome: observation.executionOutcome,
    preview: ready && typeof projection?.preview === "string" ? projection.preview : null
  };
}

/** The server-owned class of one call and, for MCP, its exact accepted identity. */
function classify(call: CallHead, run: AcceptedRun) {
  const classified = toolHistoryKind({ agent: run.agent, agentMcpTools: run.agentMcpTools, normalizedRequest: run.normalizedRequest,
    toolName: call.toolName });
  let identity: AcceptedMcpCallIdentity | null = null;
  if (classified.kind === "mcp") {
    identity = run.agent ? run.agentMcpTools.get(call.toolName)?.identity ?? null
      : call.mcpRunBinding?.modelRunId === call.modelRunId
        ? acceptedMcpCallIdentity(run.normalizedRequest, call.toolName, call.mcpRunBinding.runtimeGenerationFingerprint)
        : null;
  }
  return { ...classified, identity };
}

/** The persisted facts of one authorized call, with its owner's projection. */
async function callFacts(input: Readonly<{
  call: LoadedCall;
  context: ReadingContext;
  mcp: ReturnType<typeof mcpAuthority>;
  run: AcceptedRun;
}>): Promise<ToolCallFacts> {
  const { call, context, run } = input;
  const { identity, ...classified } = classify(call, run);
  const readable = identity ? await input.mcp.readable(identity) : false;
  const redaction = identity && readable && !run.agent
    ? await input.mcp.redaction(identity, call.mcpRunBinding?.runtimeGenerationId ?? null) : null;
  return {
    id: call.id,
    ref: toolCallRef(call.id)!,
    toolName: call.toolName,
    providerCallId: call.providerCallId,
    roundIndex: call.roundIndex,
    ordinal: call.ordinal,
    state: call.state,
    startedAt: call.startedAt?.toISOString() ?? null,
    arguments: call.arguments,
    result: call.result,
    ...(call.omittedArgumentsBytes !== undefined ? { omittedArgumentsBytes: call.omittedArgumentsBytes } : {}),
    ...(call.omittedResultBytes !== undefined ? { omittedResultBytes: call.omittedResultBytes } : {}),
    kind: classified.kind,
    label: classified.label,
    runTerminal: !activeModelRunStatuses.includes(call.modelRun.status),
    agent: run.agent,
    receipts: call.memoryToolEgressReceipts,
    observation: observationFact(call, identity),
    ...(classified.kind === "mcp" ? { mcp: { readable, redaction } } : {}),
    ...(context.retentionExpired ? { retentionExpired: true } : {})
  };
}

/** A call the reading context may describe: same chat, an eligible run on its
 * branch (or the reader's own run), never an Agent's internal execution. */
function describable(call: CallHead, context: ReadingContext, run: AcceptedRun | undefined): run is AcceptedRun {
  return call.modelRun.chatId === context.chatId && run !== undefined && run.eligible &&
    (call.modelRunId === context.runId || runOnBranchPath(context.pathIds, call.modelRun)) &&
    !(call.toolName === MANAGED_AGENT_EXEC && call.workspaceRunBindingId !== null);
}

async function loadCallHeads(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<CallHead[]> {
  return ids.length ? tx.modelRunToolCall.findMany({ where: { id: { in: [...ids] } }, select: callHeadSelect }) : [];
}

/** One call with its whole saved values, for the call reader. */
async function loadWholeCall(tx: Prisma.TransactionClient, id: string): Promise<LoadedCall | null> {
  return tx.modelRunToolCall.findUnique({ where: { id }, select: { ...callHeadSelect, arguments: true, result: true } });
}

/**
 * The saved values of `ids` for records: each whole up to the projection
 * bound, a larger one only by size (a result keeping its status and preview
 * flags). A projection of many calls never loads their large values.
 */
async function projectionValues(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, CallValues>> {
  const values = new Map<string, CallValues>();
  if (ids.length === 0) return values;
  const limit = TOOL_HISTORY_LIMITS.projectionValueBytes;
  const rows = await tx.$queryRaw<Array<{
    id: string; argumentsBytes: number; arguments: unknown; resultBytes: number | null; result: unknown;
    resultStatus: unknown; resultRawPreview: unknown;
  }>>`SELECT v."id", v."argumentsBytes", v."resultBytes",
      CASE WHEN v."argumentsBytes" <= ${limit} THEN v."arguments" END AS "arguments",
      CASE WHEN v."resultBytes" <= ${limit} THEN v."result" END AS "result",
      CASE WHEN v."resultBytes" > ${limit} THEN v."result" -> 'status' END AS "resultStatus",
      CASE WHEN v."resultBytes" > ${limit} THEN v."result" -> 'rawPreview' END AS "resultRawPreview"
    FROM (SELECT c."id", c."arguments", c."result", octet_length(c."arguments"::text) AS "argumentsBytes",
        octet_length(c."result"::text) AS "resultBytes"
      FROM "ModelRunToolCall" c WHERE c."id" IN (${Prisma.join([...ids])})) v`;
  for (const row of rows) {
    const argumentsOmitted = row.argumentsBytes > limit;
    const resultOmitted = row.resultBytes !== null && row.resultBytes > limit;
    values.set(row.id, {
      arguments: argumentsOmitted ? undefined : row.arguments,
      result: row.resultBytes === null ? null : resultOmitted
        ? { status: row.resultStatus, ...(record(row.resultRawPreview) ? { rawPreview: row.resultRawPreview } : {}) } : row.result,
      ...(argumentsOmitted ? { omittedArgumentsBytes: row.argumentsBytes } : {}),
      ...(resultOmitted ? { omittedResultBytes: row.resultBytes! } : {})
    });
  }
  return values;
}

/** Search options the call's accepted plan routed it to must still be
 * enabled and, outside Projects, entitled, as the saved-result owner checks. */
async function searchAvailable(tx: Prisma.TransactionClient, context: ReadingContext, call: CallHead, run: AcceptedRun): Promise<boolean> {
  const plan = record(run.normalizedRequest.searchPlan) ? run.normalizedRequest.searchPlan : null;
  const options = Array.isArray(plan?.options)
    ? plan.options.filter(option => record(option) && option.adapterKind !== "answer_provider_hosted") as Record<string, unknown>[] : [];
  const index = /^search_engine_(\d+)$/u.exec(call.toolName);
  const routed = call.toolName === "search_selected_engines" ? options : index ? options.slice(Number(index[1]) - 1, Number(index[1])) : [];
  if (routed.length === 0) return false;
  const entitlements = context.projectId ? null : await loadEntitlementsForUser(context.userId, tx);
  for (const option of routed) {
    if (typeof option.optionId !== "string" || typeof option.revisionId !== "string") return false;
    const revision = await tx.searchIntegrationRevision.findFirst({ where: { id: option.revisionId,
      searchStrategy: { enabled: true, archivedAt: null, searchOption: { optionId: option.optionId, enabled: true, archivedAt: null,
        ...(context.projectId ? { projectBindings: { some: { projectId: context.projectId } } } : {}) } } }, select: { id: true } });
    if (!revision || entitlements && !canAccessSearchStrategy(entitlements, option.optionId)) return false;
  }
  return true;
}

export function createPrismaToolHistoryOperations(prisma: PrismaClient) {
  return {
    /**
     * The frozen history of a new admission: every eligible call of the
     * branch's turns and of earlier attempts of each user message on it, by
     * reference and digest only, oldest first. Readers and status calls are
     * counted. Nothing is read from message bodies or call payloads.
     */
    async loadToolHistory(input: Readonly<{ chatId: string; leafMessageId: string | null; userId: string }>): Promise<ToolHistorySnapshot> {
      if (!input.leafMessageId) return { version: TOOL_HISTORY_VERSION, turns: [] };
      return prisma.$transaction(async tx => {
        if (!await resolveChatAccess(tx, { chatId: input.chatId, userId: input.userId })) return { version: TOOL_HISTORY_VERSION, turns: [] };
        const path = await tx.$queryRaw<Array<{ id: string; parentMessageId: string | null; role: string }>>`WITH RECURSIVE path AS (
          SELECT "id", "parentMessageId", "role" FROM "Message" WHERE "chatId" = ${input.chatId} AND "id" = ${input.leafMessageId}
          UNION SELECT p."id", p."parentMessageId", p."role" FROM "Message" p JOIN path c ON p."id" = c."parentMessageId"
            WHERE p."chatId" = ${input.chatId}
        ) SELECT "id", "parentMessageId", "role" FROM path`;
        // Oldest first, by walking parents from the leaf.
        const byId = new Map(path.map(row => [row.id, row]));
        const ordered: typeof path = [];
        for (let current = byId.get(input.leafMessageId!); current && ordered.length < path.length;
          current = current.parentMessageId ? byId.get(current.parentMessageId) : undefined) ordered.unshift(current);
        const onPath = new Set(ordered.map(row => row.id));
        const runs = ordered.length ? await tx.$queryRaw<Array<{ id: string; userMessageId: string; assistantMessageId: string | null }>>`
          SELECT r."id", r."userMessageId", r."assistantMessageId" FROM "ModelRun" r
          WHERE r."chatId" = ${input.chatId}
            AND (r."userMessageId" IN (${Prisma.join([...onPath])}) OR r."assistantMessageId" IN (${Prisma.join([...onPath])}))
            AND r."normalizedRequest" -> 'toolHistory' ->> 'version' = ${String(TOOL_HISTORY_VERSION)}
          ORDER BY r."createdAt" ASC, r."id" ASC` : [];
        if (runs.length === 0) return { version: TOOL_HISTORY_VERSION, turns: [] };
        const calls = await tx.modelRunToolCall.findMany({ where: { modelRunId: { in: runs.map(run => run.id) } },
          select: { id: true, modelRunId: true, toolName: true, roundIndex: true, ordinal: true, workspaceRunBindingId: true } });
        const runOrder = new Map(runs.map((run, index) => [run.id, index]));
        calls.sort((left, right) => runOrder.get(left.modelRunId)! - runOrder.get(right.modelRunId)! ||
          left.roundIndex - right.roundIndex || left.ordinal - right.ordinal);
        const answerOf = new Map<string, string>();
        for (const message of ordered) {
          if (message.role === "assistant" && message.parentMessageId && onPath.has(message.parentMessageId)) {
            answerOf.set(message.parentMessageId, message.id);
          }
        }
        type Draft = { turnMessageId: string; calls: typeof calls; readerCalls: number };
        const drafts: Draft[] = [];
        for (const message of ordered) {
          if (message.role !== "user") continue;
          const turnRuns = new Set(runs.filter(run => run.userMessageId === message.id).map(run => run.id));
          if (turnRuns.size === 0) continue;
          const turnCalls = calls.filter(call => turnRuns.has(call.modelRunId) &&
            !(call.toolName === MANAGED_AGENT_EXEC && call.workspaceRunBindingId !== null));
          const listed = turnCalls.filter(call => !isToolHistoryReaderName(call.toolName));
          const readerCalls = turnCalls.length - listed.length;
          if (listed.length === 0 && readerCalls === 0) continue;
          drafts.push({ turnMessageId: answerOf.get(message.id) ?? message.id, calls: listed, readerCalls });
        }
        // The newest calls stay listed; older ones beyond the bound are counted.
        let remaining = TOOL_HISTORY_LIMITS.calls;
        let omittedCalls = 0;
        for (let index = drafts.length - 1; index >= 0; index -= 1) {
          const draft = drafts[index]!;
          const kept = Math.min(draft.calls.length, Math.max(0, remaining));
          omittedCalls += draft.calls.length - kept;
          draft.calls = draft.calls.slice(draft.calls.length - kept);
          remaining -= kept;
        }
        const turns: ToolHistoryTurn[] = drafts
          .filter(draft => draft.calls.length > 0 || draft.readerCalls > 0)
          .slice(-TOOL_HISTORY_LIMITS.turns)
          .map(draft => ({
            turnMessageId: draft.turnMessageId,
            callRefs: draft.calls.map(call => toolCallRef(call.id)!),
            digest: toolHistoryDigest(draft.calls),
            ...(draft.readerCalls > 0 ? { readerCalls: Math.min(draft.readerCalls, TOOL_HISTORY_LIMITS.readerCalls) } : {})
          }));
        return { version: TOOL_HISTORY_VERSION, turns, ...(omittedCalls > 0 ? { omittedCalls } : {}) };
      });
    },

    /**
     * One request's records of a frozen history, rebuilt with the reader's
     * current authority: owners decide what each call discloses, a turn whose
     * listed calls no longer match their digest shows only that its details
     * are unavailable, and revoked or expired details are never projected.
     */
    async projectToolHistory(input: Readonly<{
      actor: ToolHistoryActor;
      reader: boolean;
      toolHistory: ToolHistorySnapshot;
    }>): Promise<ToolHistoryProjection> {
      const turns = input.toolHistory.turns;
      if (turns.length === 0) return { blocks: [] };
      return prisma.$transaction(async tx => {
        const context = await readingContext(tx, input.actor).catch((error: unknown) => {
          if (error instanceof ToolHistoryUnavailable) return null;
          throw error;
        });
        const ids = turns.flatMap(turn => turn.callRefs.flatMap(ref => toolCallIdFromRef(ref) ?? []));
        const heads = context ? await loadCallHeads(tx, ids) : [];
        const byId = new Map(heads.map(call => [call.id, call]));
        const runs = await acceptedRuns(tx, [...new Set(heads.map(call => call.modelRunId))]);
        const mcp = context ? mcpAuthority(tx, context) : null;
        const states = turns.map(turn => ({ records: [] as ToolHistoryRecord[], unavailableCalls: 0, userMessageId: null as string | null,
          // Earlier attempts of the current message form their own record;
          // in a past turn they are marked beside the current branch's calls.
          currentTurn: context !== null && turn.turnMessageId === context.currentUserMessageId }));
        const describableCalls: Array<Readonly<{ turn: number; call: CallHead; run: AcceptedRun; previousAttempt: boolean }>> = [];
        for (const [index, turn] of turns.entries()) {
          const state = states[index]!;
          const resolved = turn.callRefs.map(ref => byId.get(toolCallIdFromRef(ref) ?? ""));
          const complete = resolved.every((call): call is CallHead => call !== undefined) &&
            toolHistoryDigest(resolved as CallHead[]) === turn.digest;
          if (!complete || !context) {
            state.unavailableCalls = turn.callRefs.length;
            continue;
          }
          for (const call of resolved as CallHead[]) {
            const run = runs.get(call.modelRunId);
            state.userMessageId ??= call.modelRun.userMessageId;
            if (!describable(call, context, run)) state.unavailableCalls += 1;
            else describableCalls.push({ turn: index, call, run,
              previousAttempt: !state.currentTurn && call.modelRun.assistantMessageId !== turn.turnMessageId });
          }
        }
        // Saved values load in bounded batches, in order; each batch is
        // released once its records are rendered.
        for (let start = 0; context && mcp && start < describableCalls.length; start += TOOL_HISTORY_LIMITS.projectionBatchCalls) {
          const batch = describableCalls.slice(start, start + TOOL_HISTORY_LIMITS.projectionBatchCalls);
          const values = await projectionValues(tx, batch.map(entry => entry.call.id));
          for (const entry of batch) {
            const value = values.get(entry.call.id);
            if (!value) {
              states[entry.turn]!.unavailableCalls += 1;
              continue;
            }
            states[entry.turn]!.records.push(toolHistoryRecord(await callFacts({ call: { ...entry.call, ...value }, context, mcp,
              run: entry.run }), entry.previousAttempt));
          }
        }
        return { blocks: turns.map((turn, index) => toolHistoryBlock({
          turnMessageId: turn.turnMessageId,
          userMessageId: states[index]!.userMessageId,
          currentTurn: states[index]!.currentTurn,
          records: states[index]!.records,
          unavailableCalls: states[index]!.unavailableCalls,
          readerCalls: turn.readerCalls ?? 0,
          ...(index === 0 && input.toolHistory.omittedCalls ? { omittedCalls: input.toolHistory.omittedCalls } : {}),
          reader: input.reader
        })) };
      });
    },

    /** One call's authorized record for `read_tool_call`, or null when it is
     * unavailable to this run (unknown, foreign, another edit, ineligible or
     * revoked: all indistinguishable). */
    async readToolCall(actor: Readonly<{ runId: string; userId: string }>, ref: string): Promise<ToolHistoryRecord | null> {
      const id = toolCallIdFromRef(ref);
      if (!id) return null;
      return prisma.$transaction(async tx => {
        const context = await readingContext(tx, actor).catch((error: unknown) => {
          if (error instanceof ToolHistoryUnavailable) return null;
          throw error;
        });
        if (!context) return null;
        const call = await loadWholeCall(tx, id);
        if (!call) return null;
        const runs = await acceptedRuns(tx, [call.modelRunId]);
        const run = runs.get(call.modelRunId);
        if (!describable(call, context, run)) return null;
        const facts = await callFacts({ call, context, mcp: mcpAuthority(tx, context), run });
        // An earlier attempt is a run of a user message on the branch whose
        // answer is not on it; the reader's own run is never one.
        const previousAttempt = call.modelRunId !== context.runId &&
          !(call.modelRun.assistantMessageId !== null && context.pathIds.has(call.modelRun.assistantMessageId));
        return toolHistoryRecord(facts, previousAttempt);
      });
    },

    /**
     * Whether every referenced call is still readable by this run, with the
     * call reader's authority and each owner's live check (MCP grants and tool
     * restrictions, Search options), without reading any payload. Only a
     * refusal returns false; infrastructure failures propagate.
     */
    async toolCallsAvailable(actor: Readonly<{ runId: string; userId: string }>, refs: readonly string[]): Promise<boolean> {
      const ids = [...new Set(refs)].map(toolCallIdFromRef);
      if (ids.some(id => id === null)) return false;
      if (ids.length === 0) return true;
      return prisma.$transaction(async tx => {
        const context = await readingContext(tx, actor).catch((error: unknown) => {
          if (error instanceof ToolHistoryUnavailable) return null;
          throw error;
        });
        if (!context || context.retentionExpired) return false;
        const calls = await loadCallHeads(tx, ids as string[]);
        if (calls.length !== ids.length) return false;
        const runs = await acceptedRuns(tx, [...new Set(calls.map(call => call.modelRunId))]);
        const mcp = mcpAuthority(tx, context);
        for (const call of calls) {
          const run = runs.get(call.modelRunId);
          if (!describable(call, context, run)) return false;
          const { kind, identity } = classify(call, run);
          if (kind === "mcp" && !(identity && await mcp.readable(identity))) return false;
          if (kind === "web_search" && !run.agent && !await searchAvailable(tx, context, call, run)) return false;
        }
        return true;
      });
    }
  };
}

export type PrismaToolHistoryOperations = ReturnType<typeof createPrismaToolHistoryOperations>;
