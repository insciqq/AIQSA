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
    if (options.failLaneQueries === true) throw new Error("fts unavailable");
    return [];
  });
  const client = {
    $transaction: vi.fn(async () => { throw new Error("vector unavailable"); }),
    $queryRaw,
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
    expect(sql).toContain('source_chat."memoryBranchGeneration" = chunk."branchGeneration"');
    expect(result.snapshot.historySuppressionIdentitySnapshot).toMatch(/^[a-f0-9]{64}$/u);
    expect(sql).toContain('"MemorySourceBarrier"');
    expect(sql).toContain("websearch_to_tsquery('russian'");
    expect(sql).toContain("websearch_to_tsquery('simple'");
    expect(sql).not.toContain('message."content"');
    expect(sql).not.toContain('attachment."extractedText"');
  });

  it("does not run candidate lanes for generic or secret-tainted direct input", async () => {
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
      expect(result.laneResults).toEqual([]);
      expect(mocked.laneSql).toEqual([]);
    }
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
          providerModelId: "model-1",
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      }
    });
    expect(result.vectorState).toBe("DEGRADED");
    expect(result.laneResults.some((lane) => lane.lane === "FACT_FTS_ENGLISH")).toBe(true);
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
