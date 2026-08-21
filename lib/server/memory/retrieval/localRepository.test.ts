import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { planMemoryRetrieval } from "../../../domain/memory/retrieval";
import { MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION } from "../persistence/lexical";
import { createPrismaLocalMemoryRetrievalRepository } from "./localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "./vector";

const now = new Date("2026-08-10T12:00:00.000Z");

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    activeIndexGenerationId: "generation-1",
    assistantOwnerId: null,
    chatFolderId: null,
    chatId: "chat-1",
    chatMemoryMode: "NORMAL",
    folderOwnerId: null,
    generationId: "generation-1",
    generationIndexMode: "LEXICAL_ONLY",
    generationPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
    generationState: "ACTIVE",
    memoryGeneration: 2,
    memoryRevision: 4,
    ownerStatus: "active",
    referenceChatHistory: true,
    settingsRevision: 3,
    useMemoryFacts: true,
    ...overrides
  };
}

function mockClient(
  row = snapshotRow(),
  options: Readonly<{ failLaneQueries?: boolean }> = {}
) {
  const laneSql: string[] = [];
  const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) => {
    const sql = query.strings?.join("?") ?? "";
    if (sql.includes('owner."status"')) return [row];
    laneSql.push(sql);
    if (options.failLaneQueries === true && sql.includes('"MemorySearchEntry"')) {
      throw new Error("fts unavailable");
    }
    return [];
  });
  const client = {
    $transaction: vi.fn(async () => { throw new Error("vector unavailable"); }),
    $queryRaw,
    memoryPauseInterval: { findMany: vi.fn(async () => []) },
    memorySourceBarrier: { findMany: vi.fn(async () => []) },
    memorySuppression: { findMany: vi.fn(async () => []) }
  } as unknown as PrismaClient;
  return { $queryRaw, client, laneSql };
}

describe("local Memory retrieval repository", () => {
  it("emits tenant-first authoritative FTS SQL without selecting raw message content", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Когда мы обсуждали PostgreSQL в предыдущем чате?",
        now
      }),
      userId: "user-1"
    });
    expect(result.snapshot).toMatchObject({
      activeGenerationId: "generation-1",
      memoryGeneration: 2,
      memoryRevision: 4,
      status: "READY"
    });
    expect(result.vectorState).toBe("NOT_CONFIGURED");
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('entry."userId" =');
    expect(sql).toContain('scope."scopeType" = \'GLOBAL_USER\'');
    expect(sql).toContain('scope."targetIdSnapshot" IS NULL');
    expect(sql).toContain('scope."targetDisplaySnapshot" IS NULL');
    expect(sql).toContain('scope."folderId" IS NULL');
    expect(sql).toContain('scope."assistantId" IS NULL');
    expect(sql).toContain('scope."chatId" IS NULL');
    expect(sql).not.toMatch(/scope\."scopeType" = '(?:FOLDER|ASSISTANT|CHAT)'/u);
    expect(sql).toContain('version."sensitivityClass" IN (');
    expect(sql).not.toContain('version."sensitivityClass" <> \'SENSITIVE\'');
    expect(sql).not.toContain("'HIGHLY_SENSITIVE'::\"MemorySensitivityClass\"");
    expect(sql).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
    expect(sql).toContain('version."sourceMode" = \'EXPLICIT\'');
    expect(sql).toContain('source_chat."memoryBranchGeneration" = chunk."branchGeneration"');
    expect(sql).toContain('source_chat."projectId" IS NULL');
    expect(sql).toContain('chunk."chunkingVersion" =');
    expect(sql).toContain('chunk."sourceProjectionVersion" =');
    expect(sql).toContain("'SENSITIVE'::\"MemoryDerivedSafetyClass\"");
    expect(sql).toContain('negative_feedback."feedbackType" = \'NOT_USEFUL\'');
    expect(sql).toContain('negative_run."chatId" =');
    expect(sql).toContain('feedback_retraction."retractsFeedbackId" = negative_feedback."id"');
    expect(result.snapshot.historySuppressionIdentitySnapshot).toMatch(/^[a-f0-9]{64}$/u);
    expect(sql).toContain('"MemorySourceBarrier"');
    expect(sql).toContain("plainto_tsquery('simple'");
    expect(sql).not.toContain("plainto_tsquery('russian'");
    expect(sql).not.toContain("plainto_tsquery('english'");
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).not.toContain('message."content"');
    expect(sql).not.toContain('attachment."extractedText"');
  });

  it("runs candidate lanes for generic and recognizable-secret direct input", async () => {
    for (const currentUserText of [
      "What is PostgreSQL?",
      "What is my API key: sk-abcdefghijklmnopqrstuvwxyz123456?"
    ]) {
      const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
      const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
      const result = await repository.retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText, now }),
        userId: "user-1"
      });
      expect(result.laneResults.map(({ lane }) => lane)).toEqual([
        "FACT_EXACT", "FACT_FTS_SIMPLE"
      ]);
      expect(mocked.laneSql.length).toBeGreaterThan(0);
    }
  });

  it("loads query-independent response preferences only when the plan admits them", async () => {
    for (const applyResponsePreferences of [false, true]) {
      const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
      const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
      await repository.retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({
          applyResponsePreferences,
          currentUserText: "How should this answer be formatted?",
          ...(applyResponsePreferences ? { filters: { sourceKinds: [] } } : {}),
          now
        }),
        userId: "user-1"
      });
      const coreReads = mocked.laneSql.filter((sql) =>
        sql.includes('version."coreEligible" = TRUE'));
      expect(coreReads).toHaveLength(applyResponsePreferences ? 1 : 0);
      if (applyResponsePreferences) {
        expect(coreReads[0]).toContain("'SENSITIVE'::\"MemorySensitivityClass\"");
        expect(coreReads[0]).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
        expect(mocked.laneSql).toHaveLength(1);
      }
    }
  });

  it("rejects an empty dynamic-lane plan without response-preference admission", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const ordinary = planMemoryRetrieval({ currentUserText: "answer", now });
    await expect(repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: {
        ...ordinary,
        filters: { ...ordinary.filters, sourceKinds: [] }
      },
      userId: "user-1"
    })).rejects.toThrow("memory_retrieval_plan_invalid");
    expect(mocked.$queryRaw).not.toHaveBeenCalled();
  });

  it("adds a bounded recent lane only for an explicit System-plan recency request", async () => {
    const withoutRecency = mockClient(snapshotRow({ referenceChatHistory: false }));
    const ordinary = await createPrismaLocalMemoryRetrievalRepository(withoutRecency.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText: "project update", now }),
        userId: "user-1"
      });
    expect(ordinary.laneResults.map(({ lane }) => lane)).not.toContain("FACT_RECENT");
    expect(withoutRecency.laneSql.join("\n")).not.toContain(
      'version."systemFrom" DESC'
    );

    const withRecency = mockClient(snapshotRow({ referenceChatHistory: false }));
    const recent = await createPrismaLocalMemoryRetrievalRepository(withRecency.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({
          currentUserText: "project update",
          now,
          recencyRequested: true
        }),
        userId: "user-1"
      });
    expect(recent.laneResults.map(({ lane }) => lane)).toContain("FACT_RECENT");
    expect(withRecency.laneSql.join("\n")).toContain("EXTRACT(EPOCH FROM");
  });

  it("disables every read for Temporary chats before querying lanes", async () => {
    const mocked = mockClient(snapshotRow({ chatMemoryMode: "TEMPORARY" }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    await expect(repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "What is my preferred editor?", now }),
      userId: "user-1"
    })).resolves.toMatchObject({
      laneResults: [],
      snapshot: { reason: "temporary_chat", status: "DISABLED" }
    });
    expect(mocked.laneSql).toEqual([]);
  });

  it("keeps lexical lanes available when the local vector lane degrades", async () => {
    const mocked = mockClient(snapshotRow({
      generationIndexMode: "HYBRID",
      generationPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "What is my preferred editor?", now }),
      userId: "user-1",
      vector: {
        minimumScore: 0.4,
        profile: {
          configurationFingerprint: "c".repeat(64),
          connectionId: "connection-1",
          dimension: 1_024,
          generationId: "generation-1",
          minimumSimilarity: 0.55,
          providerModelId: "model-1",
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      }
    });
    expect(result.vectorState).toBe("DEGRADED");
    expect(result.laneResults.some((lane) => lane.lane === "FACT_FTS_SIMPLE")).toBe(true);
  });

  it("returns explicit failed-lane evidence instead of rejecting the whole retrieval", async () => {
    const mocked = mockClient(snapshotRow(), { failLaneQueries: true });
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "What did we discuss in the previous chat?",
        now
      }),
      userId: "user-1"
    });

    expect(result.lexicalState).toBe("FAILED");
    expect(result.lexicalFailures.length).toBeGreaterThan(0);
    expect(result.laneResults.every(({ candidates }) => candidates.length === 0)).toBe(true);
  });
});
