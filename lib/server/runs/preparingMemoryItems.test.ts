import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from
  "../memory/learning/extraction/contract";
import { memorySha256 } from "../memory/persistence/lexical";
import {
  resolvePreparingMemoryItem,
  samePreparingMemoryItemSnapshot
} from "./preparingMemoryItems";

const authority = {
  assistantId: null,
  chatId: "chat-1",
  folderId: null,
  indexGenerationId: null,
  userId: "user-1"
} as const;

const item = {
  exactItemId: "version-1",
  exactSafeText: "The user prefers concise answers.",
  factVersionId: "version-1",
  featureSnapshot: {
    historical: false,
    retrievalMode: "TARGETED_CURRENT",
    tier: "CORE"
  },
  finalScore: 0,
  itemType: "FACT_VERSION" as const,
  laneRanks: {},
  projectionKind: "FACT_DISPLAY_TEXT" as const,
  selectionReason: "core.automatic.high",
  supportingItemId: null
};

const automaticSourceText = "I prefer concise answers.";
const automaticSourceHash = memorySha256(automaticSourceText);
const automaticFactRow = Object.freeze({
  coreEligible: true,
  coreSalience: "HIGH",
  createdByEventId: "event-1",
  currentVersionId: "version-1",
  displayText: "The user prefers concise answers.",
  expectedAt: null,
  expiresAt: null,
  factCanonicalKey: "auto.opaque",
  factCategory: "memory",
  factId: "fact-1",
  factState: "ACTIVE",
  identityKind: "PROPOSITION",
  languageCode: "und",
  mergedIntoVersionId: null,
  movedFromVersionId: null,
  observedAt: null,
  occurredAt: null,
  pinned: false,
  scopeAssistantId: null,
  scopeChatId: null,
  scopeFolderId: null,
  scopeId: "scope-1",
  scopeState: "ACTIVE",
  scopeTargetIdSnapshot: null,
  scopeType: "GLOBAL_USER",
  searchSafeContentHash: null,
  sensitivityClass: "NORMAL",
  sourceMode: "AUTOMATIC",
  structuredValue: { kind: "text", value: "concise" },
  supersedesVersionId: null,
  systemFrom: new Date("2026-08-13T00:00:00.000Z"),
  systemTo: null,
  validFrom: null,
  validTo: null,
  versionState: "ACTIVE"
});

function automaticEvidenceRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    branchGeneration: 3,
    chatId: "source-chat",
    content: { blocks: [{ text: automaticSourceText, type: "text" }] },
    endOffset: automaticSourceText.length,
    evidenceId: "evidence-1",
    evidenceFingerprint: "e".repeat(64),
    messageId: "source-message",
    safeExcerpt: automaticSourceText,
    safeSourceHash: automaticSourceHash,
    sourceMessageContentHash: automaticSourceHash,
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    startOffset: 0,
    ...overrides
  };
}

describe("preparing Memory item finalization", () => {
  it("revalidates Core directly when no search generation is active", async () => {
    const $queryRaw = vi.fn(async (_query: Prisma.Sql): Promise<unknown[]> => [])
      .mockResolvedValueOnce([automaticFactRow])
      .mockResolvedValueOnce([automaticEvidenceRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const resolved = await resolvePreparingMemoryItem(
      { $queryRaw } as unknown as Prisma.TransactionClient,
      authority,
      "What do you know about me?",
      item
    );
    expect(resolved).toMatchObject({
      exactItemId: "version-1",
      factVersionId: "version-1",
      itemType: "FACT_VERSION",
      sourceBranchGenerationSnapshot: 3,
      sourceChatIdSnapshot: "source-chat",
      sourceMessageIdsSnapshot: ["source-message"],
      versionSnapshot: {
        coreEligible: true,
        coreSalience: "HIGH",
        currentVersionId: "version-1"
      }
    });
    expect(samePreparingMemoryItemSnapshot(resolved, {
      ...resolved,
      versionSnapshot: {
        ...resolved.versionSnapshot,
        dependencySnapshot: [{ dependencyKind: "CORRECTION_TARGET", id: "dependency-1" }]
      }
    })).toBe(false);
    expect(samePreparingMemoryItemSnapshot(resolved, {
      ...resolved,
      versionSnapshot: {
        ...resolved.versionSnapshot,
        entityRoots: [{ entityId: "entity-1", role: "SUBJECT", rootId: "entity-2" }]
      }
    })).toBe(false);
    expect($queryRaw).toHaveBeenCalledTimes(4);
    const factSql = $queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "";
    expect(factSql).toContain('version."safetyClassificationState" =');
    expect(factSql).toContain('version."sensitivityClass" IN (');
    expect(factSql).toContain("'SENSITIVE'::\"MemorySensitivityClass\"");
    expect(factSql).not.toContain('version."normalizedSearchText" =');
    expect(factSql).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
    expect(factSql).toContain('FROM "MemoryFeedback" AS negative_feedback');
    expect(factSql).toContain('negative_feedback."memoryFactVersionId" =');
  });

  it.each([
    {
      label: "message content hash",
      overrides: {
        content: { blocks: [{ text: "I now prefer detailed answers.", type: "text" }] }
      }
    },
    {
      label: "UTF-16 evidence offsets",
      overrides: { endOffset: automaticSourceText.length - 1 }
    },
    {
      label: "source projection version",
      overrides: { sourceProjectionVersion: "memory-fact-source-projection-v1" }
    }
  ])("rejects changed exact $label at final rejoin", async ({ overrides }) => {
    const $queryRaw = vi.fn(async (_query: Prisma.Sql): Promise<unknown[]> => [])
      .mockResolvedValueOnce([automaticFactRow])
      .mockResolvedValueOnce([automaticEvidenceRow(overrides)]);

    await expect(resolvePreparingMemoryItem(
      { $queryRaw } as unknown as Prisma.TransactionClient,
      authority,
      "What do you know about me?",
      item
    )).rejects.toMatchObject({ code: "memory_attempt_item_stale", retryable: true });
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("requires both current history projection versions at final rejoin", async () => {
    const $queryRaw = vi.fn(async (_query: Prisma.Sql): Promise<unknown[]> => [{
      branchGeneration: 2,
      chatId: "source-chat",
      contentHash: "content-hash",
      languageCode: "en",
      redactionState: "NOT_NEEDED",
      safeText: "User:\nWe chose cedar deployment.\n\nAssistant:\nNoted.",
      safetyClass: "NORMAL",
      sourceAssistantId: null,
      sourceFolderId: null,
      sourceRevision: 4,
      state: "ACTIVE"
    }]);
    const tx = {
      $queryRaw,
      memoryRecallChunkMessage: {
        findMany: vi.fn(async () => [{ messageId: "source-message" }])
      }
    } as unknown as Prisma.TransactionClient;

    await expect(resolvePreparingMemoryItem(
      tx,
      { ...authority, indexGenerationId: "generation-1" },
      "What do you know about me?",
      {
        exactItemId: "chunk-1",
        exactSafeText: "[2026-08-13] User:\nWe chose cedar deployment.\n\nAssistant:\nNoted.",
        finalScore: 0.9,
        itemType: "RECALL_CHUNK",
        projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
        recallChunkId: "chunk-1",
        selectionReason: "history_recall_exact"
      }
    )).resolves.toMatchObject({
      exactItemId: "chunk-1",
      recallChunkId: "chunk-1",
      sourceMessageIdsSnapshot: ["source-message"]
    });
    const historySql = $queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "";
    expect(historySql).toContain('chunk."chunkingVersion" =');
    expect(historySql).toContain('chunk."sourceProjectionVersion" =');
    expect(historySql).toContain('chunk."safetyClass" IN (');
    expect(historySql).toContain("'SENSITIVE'::\"MemoryDerivedSafetyClass\"");
    expect(historySql).not.toContain('entry."normalizedSearchText" =');
    expect(historySql).not.toContain("'HIGHLY_SENSITIVE'::\"MemoryDerivedSafetyClass\"");
    expect(historySql).toContain('FROM "MemoryFeedback" AS negative_feedback');
    expect(historySql).toContain('negative_feedback."recallChunkId" =');
  });

  it("rejoins an overview digest through all of its exact source messages", async () => {
    const digestText = "Summary: Cedar was selected for the deployment.";
    const $queryRaw = vi.fn(async (_query: Prisma.Sql): Promise<unknown[]> => [{
      branchGeneration: 2,
      chatId: "source-chat",
      contentHash: "anchor-content-hash",
      digestContentHash: "digest-content-hash",
      digestId: "digest-1",
      digestPipelineVersion: "memory-chat-digest-v1",
      digestSafetyPolicyVersion: "memory-chat-digest-policy-v1",
      digestText,
      languageCode: "en",
      redactionState: "NOT_NEEDED",
      safeText: digestText,
      safetyClass: "NORMAL",
      sourceAssistantId: null,
      sourceFolderId: null,
      sourceRevision: 4,
      state: "ACTIVE"
    }]);
    const tx = {
      $queryRaw,
      chatMemoryDigestMessage: {
        findMany: vi.fn(async () => [
          { messageId: "source-user" },
          { messageId: "source-assistant" }
        ])
      }
    } as unknown as Prisma.TransactionClient;

    await expect(resolvePreparingMemoryItem(
      tx,
      { ...authority, indexGenerationId: "generation-1" },
      "Give me a history overview.",
      {
        exactItemId: "chunk-1",
        exactSafeText: `[2026-08-13] ${digestText}`,
        featureSnapshot: { retrievalMode: "HISTORY_OVERVIEW" },
        finalScore: 0.9,
        itemType: "RECALL_CHUNK",
        projectionKind: "CHAT_DIGEST_SAFE_TEXT",
        recallChunkId: "chunk-1",
        selectionReason: "history_recall_recent",
        supportingItemId: "digest-1"
      }
    )).resolves.toMatchObject({
      exactItemId: "chunk-1",
      featureSnapshot: { supportingItemId: "digest-1" },
      projectionKind: "CHAT_DIGEST_SAFE_TEXT",
      sourceMessageIdsSnapshot: ["source-user", "source-assistant"],
      sourceSnapshot: { digestId: "digest-1", schemaVersion: 3 },
      versionSnapshot: {
        digestPipelineVersion: "memory-chat-digest-v1",
        schemaVersion: 3
      }
    });
    const digestSql = $queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "";
    expect(digestSql).toContain('FROM "ChatMemoryDigestChunk" AS digest_anchor');
    expect(digestSql).toContain('FROM "ChatMemoryDigestMessage" AS digest_source_message');
    expect(digestSql).toContain('LEFT JOIN "ChatMemoryCheckpointMessage"');
    expect(digestSql).toContain('source_chunk."chunkingVersion" <>');
  });

  it("still requires an exact active generation for dynamic fact items", async () => {
    const $queryRaw = vi.fn();
    await expect(resolvePreparingMemoryItem(
      { $queryRaw } as unknown as Prisma.TransactionClient,
      authority,
      "concise answers",
      {
        ...item,
        featureSnapshot: { ...item.featureSnapshot, tier: "DYNAMIC" },
        selectionReason: "rrf+relevance"
      }
    )).rejects.toMatchObject({ code: "memory_attempt_item_stale", retryable: true });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
