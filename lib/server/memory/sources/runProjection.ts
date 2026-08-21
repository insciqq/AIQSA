import type { PrismaClient } from "@prisma/client";
import type { MemoryAnswerSource } from "../../../contracts/memoryClient";
import {
  defaultMemoryClientRefService,
  type MemoryClientRefOperation,
  type MemoryClientRefService
} from "../actions/clientRef";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import {
  loadPersonalEligibleFactVersionIds,
  loadPersonalMemoryEvidenceSnapshots,
  loadPersonalMemoryRunIds
} from "../persistence/eligibility";
import { canonicalGlobalMemoryScopeWhere } from "../persistence/scopes";

type MemoryRunSourceClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "chatMemoryCheckpoint"
  | "chat"
  | "memoryFact"
  | "memoryFactVersion"
  | "memorySuppression"
  | "memoryScope"
  | "memoryRecallChunk"
  | "memoryRecallChunkMessage"
  | "message"
  | "modelRun"
  | "modelRunMemoryBinding"
  | "modelRunMemoryItem"
>;

function boundedText(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function loadMemoryRunSources(
  client: MemoryRunSourceClient,
  input: Readonly<{
    clientRefs?: MemoryClientRefService;
    runIds: readonly string[];
    userId: string;
  }>
): Promise<ReadonlyMap<string, readonly MemoryAnswerSource[]>> {
  const runIds = [...new Set(input.runIds.filter(Boolean))];
  if (runIds.length === 0) return new Map();
  const personalRunIds = await loadPersonalMemoryRunIds(
    client,
    input.userId,
    runIds
  );
  if (personalRunIds.size === 0) return new Map();
  const bindings = await client.modelRunMemoryBinding.findMany({
    select: { id: true, modelRunId: true },
    where: { modelRunId: { in: [...personalRunIds] }, userId: input.userId }
  });
  if (bindings.length === 0) return new Map();
  const runByBindingId = new Map(bindings.map((binding) => [binding.id, binding.modelRunId]));
  const items = await client.modelRunMemoryItem.findMany({
    orderBy: [{ bindingId: "asc" }, { ordinal: "asc" }],
    select: {
      bindingId: true,
      factVersionId: true,
      includedText: true,
      itemType: true,
      recallChunkId: true,
      sourceBranchGenerationSnapshot: true,
      sourceChatIdSnapshot: true,
      sourceContentHashSnapshot: true,
      sourceMessageIdsSnapshot: true,
      sourceRevisionSnapshot: true
    },
    where: { bindingId: { in: bindings.map(({ id }) => id) }, userId: input.userId }
  });
  const factVersionIds = items.flatMap((item) => item.factVersionId ? [item.factVersionId] : []);
  const chunkIds = items.flatMap((item) => item.recallChunkId ? [item.recallChunkId] : []);
  const sourceChatIds = items.flatMap((item) => item.sourceChatIdSnapshot
    ? [item.sourceChatIdSnapshot]
    : []);
  const sourceMessageIds = [...new Set(items.flatMap((item) =>
    item.sourceMessageIdsSnapshot))];
  const [
    versions,
    chunks,
    chats,
    checkpoints,
    chunkMessageJoins,
    sourceMessages,
    sourceSuppressions
  ] = await Promise.all([
    factVersionIds.length > 0
      ? client.memoryFactVersion.findMany({
          select: {
            contentPurgedAt: true,
            factId: true,
            id: true,
            safetyClassificationState: true,
            sensitivityClass: true,
            sourceMode: true,
            state: true,
            systemFrom: true
          },
          where: { id: { in: factVersionIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    chunkIds.length > 0
      ? client.memoryRecallChunk.findMany({
          select: {
            branchGeneration: true,
            chatId: true,
            chunkingVersion: true,
            contentHash: true,
            id: true,
            occurredTo: true,
            redactionState: true,
            safetyClass: true,
            sourceProjectionVersion: true,
            sourceRevisionAtCreation: true,
            state: true
          },
          where: { id: { in: chunkIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0
      ? client.chat.findMany({
          select: {
            id: true,
            memoryBranchGeneration: true,
            memoryMode: true,
            memorySourceRevision: true,
            permanentDeletionAt: true,
            projectId: true,
            title: true
          },
          where: { id: { in: sourceChatIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0
      ? client.chatMemoryCheckpoint.findMany({
          select: { chatId: true, pipelineVersion: true },
          where: { chatId: { in: sourceChatIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    chunkIds.length > 0
      ? client.memoryRecallChunkMessage.findMany({
          orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
          select: { chatId: true, chunkId: true, messageId: true },
          where: { chunkId: { in: chunkIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0 && sourceMessageIds.length > 0
      ? client.message.findMany({
          select: { chatId: true, id: true },
          where: {
            chatId: { in: sourceChatIds },
            id: { in: sourceMessageIds }
          }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0 && sourceMessageIds.length > 0
      ? client.memorySuppression.findMany({
          select: {
            sourceBranchGeneration: true,
            sourceChatId: true,
            sourceMessageId: true
          },
          where: {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            scope: "SOURCE_MESSAGE",
            sourceChatId: { in: sourceChatIds },
            sourceMessageId: { in: sourceMessageIds },
            userId: input.userId
          }
        })
      : Promise.resolve([])
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const [eligibleVersionIds, evidenceSnapshots] = await Promise.all([
    loadPersonalEligibleFactVersionIds(client, input.userId, factVersionIds),
    loadPersonalMemoryEvidenceSnapshots(client, input.userId, factVersionIds)
  ]);
  const evidenceByVersionId = new Map<string, typeof evidenceSnapshots>();
  for (const evidence of evidenceSnapshots) {
    evidenceByVersionId.set(evidence.factVersionId, [
      ...(evidenceByVersionId.get(evidence.factVersionId) ?? []),
      evidence
    ]);
  }
  const facts = versions.length > 0
    ? await client.memoryFact.findMany({
        select: { currentVersionId: true, id: true, scopeId: true, state: true },
        where: {
          id: { in: [...new Set(versions.map((version) => version.factId))] },
          userId: input.userId
        }
      })
    : [];
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const canonicalScopeIds = new Set(facts.length > 0
    ? (await client.memoryScope.findMany({
        select: { id: true },
        where: {
          ...canonicalGlobalMemoryScopeWhere(),
          id: { in: [...new Set(facts.map(({ scopeId }) => scopeId))] },
          userId: input.userId
        }
      })).map(({ id }) => id)
    : []);
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const checkpointByChatId = new Map(checkpoints.map((checkpoint) => [
    checkpoint.chatId,
    checkpoint
  ]));
  const joinsByChunkId = new Map<string, typeof chunkMessageJoins>();
  for (const join of chunkMessageJoins) {
    joinsByChunkId.set(join.chunkId, [
      ...(joinsByChunkId.get(join.chunkId) ?? []),
      join
    ]);
  }
  const messageKeys = new Set(sourceMessages.map((message) =>
    `${message.chatId}\u0000${message.id}`));
  const refs = input.clientRefs ?? defaultMemoryClientRefService;
  const sourcesByRun = new Map<string, MemoryAnswerSource[]>();

  for (const item of items) {
    const runId = runByBindingId.get(item.bindingId);
    if (!runId) continue;
    let source: MemoryAnswerSource | null = null;
    if (item.itemType === "FACT_VERSION" && item.factVersionId) {
      const version = versionById.get(item.factVersionId);
      const fact = version ? factById.get(version.factId) : null;
      if (
        !version || !fact || version.contentPurgedAt || !item.includedText ||
        version.state !== "ACTIVE" || version.safetyClassificationState !== "CLASSIFIED" ||
        (version.sensitivityClass !== "NORMAL" && version.sensitivityClass !== "SENSITIVE") ||
        fact.state !== "ACTIVE" || fact.currentVersionId !== version.id ||
        !canonicalScopeIds.has(fact.scopeId) || !eligibleVersionIds.has(version.id)
      ) continue;
      const evidence = evidenceByVersionId.get(version.id) ?? [];
      const evidenceChat = item.sourceChatIdSnapshot
        ? chatById.get(item.sourceChatIdSnapshot)
        : null;
      const evidenceMessageIds = new Set(evidence.flatMap((candidate) =>
        candidate.chatId === item.sourceChatIdSnapshot &&
          candidate.branchGeneration === item.sourceBranchGenerationSnapshot
          ? [candidate.messageId]
          : []));
      const sourceNavigationAvailable = Boolean(
        version.sourceMode === "AUTOMATIC" && evidenceChat &&
        item.sourceBranchGenerationSnapshot !== null &&
        item.sourceMessageIdsSnapshot.length > 0 &&
        evidenceChat.projectId === null && evidenceChat.memoryMode === "NORMAL" &&
        evidenceChat.permanentDeletionAt === null &&
        evidenceChat.memoryBranchGeneration === item.sourceBranchGenerationSnapshot &&
        item.sourceMessageIdsSnapshot.every((messageId) =>
          evidenceMessageIds.has(messageId) &&
          messageKeys.has(`${evidenceChat.id}\u0000${messageId}`))
      );
      const operations: MemoryClientRefOperation[] = ["EDIT", "FORGET", "NOT_RELEVANT"];
      if (sourceNavigationAvailable) operations.push("OPEN_SOURCE");
      const memoryRef = refs.mint(input.userId, {
        allowedOperations: operations,
        originatingRunId: runId,
        target: {
          exactItemId: version.id,
          factId: version.factId,
          factVersionId: version.id,
          itemType: "FACT_VERSION",
          recallChunkId: null,
          sourceChatId: sourceNavigationAvailable ? evidenceChat!.id : null,
          sourceMessageIds: sourceNavigationAvailable
            ? item.sourceMessageIdsSnapshot
            : []
        }
      });
      const factSourceBase = {
        date: version.systemFrom.toISOString(),
        memoryRef,
        sourceAvailable: true as const,
        text: boundedText(item.includedText, 1_000)
      };
      source = version.sourceMode === "AUTOMATIC"
        ? sourceNavigationAvailable
          ? {
              ...factSourceBase,
              actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
              sourceType: "LEARNED_MEMORY"
            }
          : {
              ...factSourceBase,
              actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
              sourceType: "LEARNED_MEMORY"
            }
        : {
            ...factSourceBase,
            actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
            sourceType: "SAVED_MEMORY"
          };
    } else if (item.itemType === "RECALL_CHUNK" && item.recallChunkId &&
      item.sourceChatIdSnapshot) {
      const chunk = chunkById.get(item.recallChunkId);
      const chat = chatById.get(item.sourceChatIdSnapshot);
      const checkpoint = checkpointByChatId.get(item.sourceChatIdSnapshot);
      const chunkJoins = joinsByChunkId.get(item.recallChunkId) ?? [];
      const joinedMessageIds = chunkJoins.map((join) => join.messageId);
      const sourceSuppressed = sourceSuppressions.some((suppression) =>
        suppression.sourceChatId === item.sourceChatIdSnapshot &&
        suppression.sourceMessageId !== null &&
        item.sourceMessageIdsSnapshot.includes(suppression.sourceMessageId) &&
        (suppression.sourceBranchGeneration === null ||
          suppression.sourceBranchGeneration === item.sourceBranchGenerationSnapshot));
      const available = Boolean(
        chunk && chat && checkpoint && chunk.chatId === chat.id && chunk.state === "ACTIVE" &&
        checkpoint.pipelineVersion === MEMORY_HISTORY_INDEX_PIPELINE_VERSION &&
        item.sourceBranchGenerationSnapshot !== null &&
        item.sourceContentHashSnapshot !== null &&
        chunk.chunkingVersion === MEMORY_HISTORY_CHUNKING_VERSION &&
        chunk.sourceProjectionVersion === MEMORY_HISTORY_SOURCE_PROJECTION_VERSION &&
        chunk.branchGeneration === item.sourceBranchGenerationSnapshot &&
        chunk.contentHash === item.sourceContentHashSnapshot &&
        chunk.redactionState !== "EXCLUDED" &&
        (chunk.safetyClass === "NORMAL" || chunk.safetyClass === "SENSITIVE") &&
        chunk.sourceRevisionAtCreation === item.sourceRevisionSnapshot &&
        chat.memoryBranchGeneration === item.sourceBranchGenerationSnapshot &&
        chat.memorySourceRevision === item.sourceRevisionSnapshot &&
        chat.memoryMode === "NORMAL" && chat.permanentDeletionAt === null &&
        chat.projectId === null &&
        !sourceSuppressed &&
        item.sourceMessageIdsSnapshot.length > 0 &&
        chunkJoins.every((join) => join.chatId === chat.id) &&
        sameStrings(joinedMessageIds, item.sourceMessageIdsSnapshot) &&
        item.sourceMessageIdsSnapshot.every((messageId) =>
          messageKeys.has(`${chat.id}\u0000${messageId}`))
      );
      if (!chunk || !available || !item.includedText) continue;
      source = {
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: chunk.occurredTo.toISOString(),
        memoryRef: refs.mint(input.userId, {
          allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
          originatingRunId: runId,
          target: {
            exactItemId: chunk.id,
            factId: null,
            factVersionId: null,
            itemType: "RECALL_CHUNK",
            recallChunkId: chunk.id,
            sourceChatId: chat!.id,
            sourceMessageIds: item.sourceMessageIdsSnapshot
          }
        }),
        ...(chat!.title.trim()
          ? { origin: boundedText(chat!.title, 200) }
          : {}),
        sourceAvailable: true,
        sourceType: "PAST_CHAT",
        text: boundedText(item.includedText, 1_000)
      };
    }
    if (!source) continue;
    const current = sourcesByRun.get(runId) ?? [];
    current.push(source);
    sourcesByRun.set(runId, current);
  }
  return sourcesByRun;
}
