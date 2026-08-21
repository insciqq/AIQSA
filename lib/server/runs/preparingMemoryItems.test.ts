import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { resolvePreparingMemoryItem } from "./preparingMemoryItems";

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
  featureSnapshot: { tier: "CORE" },
  finalScore: 0,
  itemType: "FACT_VERSION" as const,
  laneRanks: {},
  projectionKind: "FACT_DISPLAY_TEXT" as const,
  selectionReason: "core.automatic.high",
  supportingItemId: null
};

describe("preparing Memory item finalization", () => {
  it("revalidates Core directly when no search generation is active", async () => {
    const $queryRaw = vi.fn(async (_query: Prisma.Sql): Promise<unknown[]> => [])
      .mockResolvedValueOnce([{
      coreEligible: true,
      coreSalience: "HIGH",
      createdByEventId: "event-1",
      currentVersionId: "version-1",
      displayText: "The user prefers concise answers.",
      factCanonicalKey: "auto.opaque",
      factCategory: "memory",
      factId: "fact-1",
      factState: "ACTIVE",
      languageCode: "und",
      pinned: false,
      scopeAssistantId: null,
      scopeChatId: null,
      scopeFolderId: null,
      scopeId: "scope-1",
      scopeState: "ACTIVE",
      scopeTargetIdSnapshot: null,
      scopeType: "GLOBAL_USER",
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      systemFrom: new Date("2026-08-13T00:00:00.000Z"),
      systemTo: null,
      validFrom: null,
      validTo: null,
      versionState: "ACTIVE"
      }])
      .mockResolvedValueOnce([{
        branchGeneration: 3,
        chatId: "source-chat",
        evidenceId: "evidence-1",
        messageId: "source-message"
      }]);

    await expect(resolvePreparingMemoryItem(
      { $queryRaw } as unknown as Prisma.TransactionClient,
      authority,
      "What do you know about me?",
      item
    )).resolves.toMatchObject({
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
    expect($queryRaw).toHaveBeenCalledTimes(2);
    const factSql = $queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "";
    expect(factSql).toContain('version."safetyClassificationState" =');
    expect(factSql).toContain('version."sensitivityClass" IN (');
    expect(factSql).toContain("'SENSITIVE'::\"MemorySensitivityClass\"");
    expect(factSql).not.toContain('version."normalizedSearchText" =');
    expect(factSql).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
    expect(factSql).toContain('FROM "MemoryFeedback" AS negative_feedback');
    expect(factSql).toContain('negative_feedback."memoryFactVersionId" =');
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

  it("still requires an exact active generation for dynamic fact items", async () => {
    const $queryRaw = vi.fn();
    await expect(resolvePreparingMemoryItem(
      { $queryRaw } as unknown as Prisma.TransactionClient,
      authority,
      "concise answers",
      { ...item, featureSnapshot: { tier: "DYNAMIC" }, selectionReason: "rrf+relevance" }
    )).rejects.toMatchObject({ code: "memory_attempt_item_stale", retryable: true });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
