import type { PrismaClient } from "@prisma/client";
import type { MemoryAnswerSource } from "../../../contracts/memoryClient";
import {
  defaultMemoryClientRefService,
  type MemoryClientRefOperation,
  type MemoryClientRefService
} from "../actions/clientRef";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../history/rounds";
import {
  loadPersonalMemoryEvidenceSnapshots,
  loadPersonalMemoryRunIds
} from "../persistence/eligibility";
import { canonicalGlobalMemoryScopeWhere } from "../persistence/scopes";
import { loadMemoryReusableFactVersionIds } from "../synthesis/eligibility";

type MemoryRunSourceClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "chatMemoryCheckpointMessage"
  | "chatMemoryDigest"
  | "chatMemoryDigestMessage"
  | "chatMemoryCheckpoint"
  | "chat"
  | "memoryFact"
  | "memoryFactVersion"
  | "memorySuppression"
  | "memoryScope"
  | "memoryRecallChunk"
  | "memoryRecallChunkMessage"
  | "memoryRecallRound"
  | "memoryRecallRoundMessage"
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

function digestIdFromFeatureSnapshot(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const feature = value as Record<string, unknown>;
  return feature.projectionKind === "CHAT_DIGEST_SAFE_TEXT" &&
    typeof feature.supportingItemId === "string" && feature.supportingItemId.length > 0
    ? feature.supportingItemId
    : null;
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
  const now = new Date();
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
      featureSnapshot: true,
      includedText: true,
      itemType: true,
      recallChunkId: true,
      recallRoundId: true,
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
  const roundIds = items.flatMap((item) => item.recallRoundId ? [item.recallRoundId] : []);
  const sourceChatIds = items.flatMap((item) => item.sourceChatIdSnapshot
    ? [item.sourceChatIdSnapshot]
    : []);
  const sourceMessageIds = [...new Set(items.flatMap((item) =>
    item.sourceMessageIdsSnapshot))];
  const digestIds = [...new Set(items.flatMap((item) => {
    const digestId = digestIdFromFeatureSnapshot(item.featureSnapshot);
    return digestId ? [digestId] : [];
  }))];
  const [
    versions,
    chunks,
    rounds,
    chats,
    checkpoints,
    chunkMessageJoins,
    roundMessageJoins,
    sourceMessages,
    sourceSuppressions,
    checkpointMessages,
    digests,
    digestMessages
  ] = await Promise.all([
    factVersionIds.length > 0
      ? client.memoryFactVersion.findMany({
          select: {
            contentPurgedAt: true,
            expiresAt: true,
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
    roundIds.length > 0
      ? client.memoryRecallRound.findMany({
          select: {
            branchGeneration: true,
            chatId: true,
            contentHash: true,
            contextualKeyPolicyVersion: true,
            contextualKeyState: true,
            id: true,
            occurredTo: true,
            parentChunkId: true,
            projectionVersion: true,
            redactionState: true,
            safetyClass: true,
            sourceProjectionVersion: true,
            sourceRevisionAtCreation: true,
            state: true
          },
          where: { id: { in: roundIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0
      ? client.chat.findMany({
          select: {
            activeLeafMessageId: true,
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
          select: {
            activeLeafMessageId: true,
            branchGeneration: true,
            chatId: true,
            lastIndexedMessageId: true,
            pipelineVersion: true,
            sourceContentHash: true,
            sourceRevision: true,
            status: true
          },
          where: { chatId: { in: sourceChatIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    chunkIds.length > 0
      ? client.memoryRecallChunkMessage.findMany({
          orderBy: [{ chunkId: "asc" }, { ordinal: "asc" }],
          select: {
            chatId: true,
            chunkId: true,
            messageId: true,
            sourceMessageUpdatedAt: true
          },
          where: { chunkId: { in: chunkIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    roundIds.length > 0
      ? client.memoryRecallRoundMessage.findMany({
          orderBy: [{ roundId: "asc" }, { ordinal: "asc" }],
          select: {
            chatId: true,
            messageId: true,
            roundId: true,
            sourceMessageUpdatedAt: true
          },
          where: { roundId: { in: roundIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0 && sourceMessageIds.length > 0
      ? client.message.findMany({
          select: { chatId: true, id: true, updatedAt: true },
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
      : Promise.resolve([]),
    sourceChatIds.length > 0 && sourceMessageIds.length > 0
      ? client.chatMemoryCheckpointMessage.findMany({
          select: {
            chatId: true,
            messageId: true,
            sourceMessageUpdatedAt: true
          },
          where: {
            chatId: { in: sourceChatIds },
            messageId: { in: sourceMessageIds },
            userId: input.userId
          }
        })
      : Promise.resolve([]),
    digestIds.length > 0
      ? client.chatMemoryDigest.findMany({
          select: {
            activeLeafMessageId: true,
            anchorChunkId: true,
            branchGeneration: true,
            chatId: true,
            contentHash: true,
            id: true,
            occurredTo: true,
            pipelineVersion: true,
            redactionState: true,
            safetyClass: true,
            sourceContentHash: true,
            sourceProjectionVersion: true,
            sourceRevisionAtCreation: true,
            state: true
          },
          where: { id: { in: digestIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    digestIds.length > 0
      ? client.chatMemoryDigestMessage.findMany({
          orderBy: [{ digestId: "asc" }, { ordinal: "asc" }],
          select: {
            chatId: true,
            digestId: true,
            messageId: true,
            sourceMessageUpdatedAt: true
          },
          where: { digestId: { in: digestIds }, userId: input.userId }
        })
      : Promise.resolve([])
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const [eligibleVersionIds, evidenceSnapshots] = await Promise.all([
    loadMemoryReusableFactVersionIds(client, input.userId, factVersionIds, {
      includePatterns: true
    }),
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
  const missingParentIds = [...new Set(rounds.map(({ parentChunkId }) => parentChunkId))]
    .filter((id) => !chunks.some((chunk) => chunk.id === id));
  const roundParents = missingParentIds.length > 0
    ? await client.memoryRecallChunk.findMany({
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
        where: { id: { in: missingParentIds }, userId: input.userId }
      })
    : [];
  const chunkById = new Map([...chunks, ...roundParents].map((chunk) => [chunk.id, chunk]));
  const roundById = new Map(rounds.map((round) => [round.id, round]));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const checkpointByChatId = new Map(checkpoints.map((checkpoint) => [
    checkpoint.chatId,
    checkpoint
  ]));
  const checkpointMessageKeys = new Set(checkpointMessages.map((message) =>
    `${message.chatId}\u0000${message.messageId}\u0000${message.sourceMessageUpdatedAt.toISOString()}`));
  const digestById = new Map(digests.map((digest) => [digest.id, digest]));
  const messagesByDigestId = new Map<string, typeof digestMessages>();
  for (const message of digestMessages) {
    messagesByDigestId.set(message.digestId, [
      ...(messagesByDigestId.get(message.digestId) ?? []),
      message
    ]);
  }
  const joinsByChunkId = new Map<string, typeof chunkMessageJoins>();
  for (const join of chunkMessageJoins) {
    joinsByChunkId.set(join.chunkId, [
      ...(joinsByChunkId.get(join.chunkId) ?? []),
      join
    ]);
  }
  const joinsByRoundId = new Map<string, typeof roundMessageJoins>();
  for (const join of roundMessageJoins) {
    joinsByRoundId.set(join.roundId, [
      ...(joinsByRoundId.get(join.roundId) ?? []),
      join
    ]);
  }
  const messageKeys = new Set(sourceMessages.map((message) =>
    `${message.chatId}\u0000${message.id}`));
  const messageUpdatedAtKeys = new Set(sourceMessages.map((message) =>
    `${message.chatId}\u0000${message.id}\u0000${message.updatedAt.toISOString()}`));
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
        (version.expiresAt !== null && version.expiresAt <= now) ||
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
          recallRoundId: null,
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
      const digestId = digestIdFromFeatureSnapshot(item.featureSnapshot);
      const chunk = chunkById.get(item.recallChunkId);
      const chat = chatById.get(item.sourceChatIdSnapshot);
      const checkpoint = checkpointByChatId.get(item.sourceChatIdSnapshot);
      const chunkJoins = joinsByChunkId.get(item.recallChunkId) ?? [];
      const joinedMessageIds = chunkJoins.map((join) => join.messageId);
      const digest = digestId ? digestById.get(digestId) : null;
      const digestMessageRows = digestId ? messagesByDigestId.get(digestId) ?? [] : [];
      const digestMessageIds = digestMessageRows.map((message) => message.messageId);
      const sourceSuppressed = sourceSuppressions.some((suppression) =>
        suppression.sourceChatId === item.sourceChatIdSnapshot &&
        suppression.sourceMessageId !== null &&
        item.sourceMessageIdsSnapshot.includes(suppression.sourceMessageId) &&
        (digestId !== null || suppression.sourceBranchGeneration === null ||
          suppression.sourceBranchGeneration === chunk?.branchGeneration));
      const currentCheckpoint = Boolean(
        chat && checkpoint && chat.activeLeafMessageId !== null &&
        checkpoint.status === "READY" &&
        checkpoint.pipelineVersion === MEMORY_HISTORY_INDEX_PIPELINE_VERSION &&
        checkpoint.branchGeneration === chat.memoryBranchGeneration &&
        checkpoint.sourceRevision === chat.memorySourceRevision &&
        checkpoint.activeLeafMessageId === chat.activeLeafMessageId &&
        checkpoint.lastIndexedMessageId === checkpoint.activeLeafMessageId &&
        chat.memoryMode === "NORMAL" && chat.permanentDeletionAt === null &&
        chat.projectId === null
      );
      const frozenChunk = Boolean(
        chunk && chat && chunk.chatId === chat.id && chunk.state === "ACTIVE" &&
        item.sourceBranchGenerationSnapshot !== null &&
        item.sourceContentHashSnapshot !== null &&
        chunk.chunkingVersion === MEMORY_HISTORY_CHUNKING_VERSION &&
        chunk.sourceProjectionVersion === MEMORY_HISTORY_SOURCE_PROJECTION_VERSION &&
        chunk.branchGeneration === item.sourceBranchGenerationSnapshot &&
        chunk.contentHash === item.sourceContentHashSnapshot &&
        chunk.redactionState !== "EXCLUDED" &&
        (chunk.safetyClass === "NORMAL" || chunk.safetyClass === "SENSITIVE") &&
        chunk.sourceRevisionAtCreation === item.sourceRevisionSnapshot
      );
      const currentChunkMap = Boolean(chat && chunkJoins.length > 0 &&
        chunkJoins.every((join) => join.chatId === chat.id &&
          messageKeys.has(`${chat.id}\u0000${join.messageId}`) &&
          messageUpdatedAtKeys.has(
            `${chat.id}\u0000${join.messageId}\u0000${join.sourceMessageUpdatedAt.toISOString()}`
          ) && checkpointMessageKeys.has(
            `${chat.id}\u0000${join.messageId}\u0000${join.sourceMessageUpdatedAt.toISOString()}`
          )));
      const digestAvailable = Boolean(
        digestId && digest && chat && checkpoint &&
        digest.id === digestId && digest.anchorChunkId === item.recallChunkId &&
        digest.chatId === chat.id && digest.state === "ACTIVE" &&
        digest.pipelineVersion === MEMORY_CHAT_DIGEST_PIPELINE_VERSION &&
        digest.sourceProjectionVersion === MEMORY_HISTORY_SOURCE_PROJECTION_VERSION &&
        digest.redactionState !== "EXCLUDED" &&
        (digest.safetyClass === "NORMAL" || digest.safetyClass === "SENSITIVE") &&
        digest.branchGeneration === checkpoint.branchGeneration &&
        digest.sourceRevisionAtCreation === checkpoint.sourceRevision &&
        digest.activeLeafMessageId === checkpoint.activeLeafMessageId &&
        digest.sourceContentHash === checkpoint.sourceContentHash &&
        digestMessageRows.length > 0 &&
        sameStrings(digestMessageIds, item.sourceMessageIdsSnapshot) &&
        digestMessageRows.every((message) => message.chatId === chat.id &&
          messageUpdatedAtKeys.has(
            `${chat.id}\u0000${message.messageId}\u0000${message.sourceMessageUpdatedAt.toISOString()}`
          ) && checkpointMessageKeys.has(
            `${chat.id}\u0000${message.messageId}\u0000${message.sourceMessageUpdatedAt.toISOString()}`
          ))
      );
      const rawChunkAvailable = digestId === null &&
        sameStrings(joinedMessageIds, item.sourceMessageIdsSnapshot);
      const available = currentCheckpoint && frozenChunk && currentChunkMap &&
        !sourceSuppressed && (rawChunkAvailable || digestAvailable);
      if (!chunk || !available || !item.includedText) continue;
      source = {
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: (digest?.occurredTo ?? chunk.occurredTo).toISOString(),
        memoryRef: refs.mint(input.userId, {
          allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
          originatingRunId: runId,
          target: {
            exactItemId: chunk.id,
            factId: null,
            factVersionId: null,
            itemType: "RECALL_CHUNK",
            recallChunkId: chunk.id,
            recallRoundId: null,
            sourceChatId: chat!.id,
            sourceMessageIds: joinedMessageIds
          }
        }),
        ...(chat!.title.trim()
          ? { origin: boundedText(chat!.title, 200) }
          : {}),
        sourceAvailable: true,
        sourceType: "PAST_CHAT",
        text: boundedText(item.includedText, 1_000)
      };
    } else if (item.itemType === "RECALL_ROUND" && item.recallRoundId &&
      item.sourceChatIdSnapshot) {
      const round = roundById.get(item.recallRoundId);
      const parent = round ? chunkById.get(round.parentChunkId) : null;
      const chat = chatById.get(item.sourceChatIdSnapshot);
      const checkpoint = checkpointByChatId.get(item.sourceChatIdSnapshot);
      const roundJoins = joinsByRoundId.get(item.recallRoundId) ?? [];
      const joinedMessageIds = roundJoins.map((join) => join.messageId);
      const sourceSuppressed = sourceSuppressions.some((suppression) =>
        suppression.sourceChatId === item.sourceChatIdSnapshot &&
        suppression.sourceMessageId !== null &&
        item.sourceMessageIdsSnapshot.includes(suppression.sourceMessageId) &&
        (suppression.sourceBranchGeneration === null ||
          suppression.sourceBranchGeneration === round?.branchGeneration));
      const currentCheckpoint = Boolean(
        chat && checkpoint && chat.activeLeafMessageId !== null &&
        checkpoint.status === "READY" &&
        checkpoint.pipelineVersion === MEMORY_HISTORY_INDEX_PIPELINE_VERSION &&
        checkpoint.branchGeneration === chat.memoryBranchGeneration &&
        checkpoint.sourceRevision === chat.memorySourceRevision &&
        checkpoint.activeLeafMessageId === chat.activeLeafMessageId &&
        checkpoint.lastIndexedMessageId === checkpoint.activeLeafMessageId &&
        chat.memoryMode === "NORMAL" && chat.permanentDeletionAt === null &&
        chat.projectId === null
      );
      const frozenRound = Boolean(
        round && chat && round.chatId === chat.id && round.state === "ACTIVE" &&
        item.sourceBranchGenerationSnapshot !== null &&
        item.sourceContentHashSnapshot !== null &&
        round.projectionVersion === MEMORY_RECALL_ROUND_PROJECTION_VERSION &&
        round.contextualKeyPolicyVersion === MEMORY_CONTEXTUAL_KEY_POLICY_VERSION &&
        (round.contextualKeyState === "GENERATED" ||
          round.contextualKeyState === "RAW_FALLBACK") &&
        round.sourceProjectionVersion === MEMORY_HISTORY_SOURCE_PROJECTION_VERSION &&
        round.branchGeneration === item.sourceBranchGenerationSnapshot &&
        round.contentHash === item.sourceContentHashSnapshot &&
        round.redactionState !== "EXCLUDED" &&
        (round.safetyClass === "NORMAL" || round.safetyClass === "SENSITIVE") &&
        round.sourceRevisionAtCreation === item.sourceRevisionSnapshot
      );
      const frozenParent = Boolean(
        parent && round && parent.id === round.parentChunkId && parent.chatId === round.chatId &&
        parent.state === "ACTIVE" &&
        parent.chunkingVersion === MEMORY_HISTORY_CHUNKING_VERSION &&
        parent.sourceProjectionVersion === MEMORY_HISTORY_SOURCE_PROJECTION_VERSION &&
        parent.redactionState !== "EXCLUDED" &&
        (parent.safetyClass === "NORMAL" || parent.safetyClass === "SENSITIVE")
      );
      const currentRoundMap = Boolean(chat && roundJoins.length > 0 &&
        sameStrings(joinedMessageIds, item.sourceMessageIdsSnapshot) &&
        roundJoins.every((join) => join.chatId === chat.id &&
          messageKeys.has(`${chat.id}\u0000${join.messageId}`) &&
          messageUpdatedAtKeys.has(
            `${chat.id}\u0000${join.messageId}\u0000${join.sourceMessageUpdatedAt.toISOString()}`
          ) && checkpointMessageKeys.has(
            `${chat.id}\u0000${join.messageId}\u0000${join.sourceMessageUpdatedAt.toISOString()}`
          )));
      const available = currentCheckpoint && frozenRound && frozenParent && currentRoundMap &&
        !sourceSuppressed;
      if (!round || !available || !item.includedText) continue;
      source = {
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: round.occurredTo.toISOString(),
        memoryRef: refs.mint(input.userId, {
          allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
          originatingRunId: runId,
          target: {
            exactItemId: round.id,
            factId: null,
            factVersionId: null,
            itemType: "RECALL_ROUND",
            recallChunkId: null,
            recallRoundId: round.id,
            sourceChatId: chat!.id,
            sourceMessageIds: joinedMessageIds
          }
        }),
        ...(chat!.title.trim() ? { origin: boundedText(chat!.title, 200) } : {}),
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
