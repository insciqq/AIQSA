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
    const $queryRaw = vi.fn()
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
      null,
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
