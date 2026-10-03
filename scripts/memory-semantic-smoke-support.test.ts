import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConsumerSettingsResponse } from "../lib/contracts/memoryConsumer";
import {
  createMemoryExecutionSnapshot,
  resolveMemoryExecutionCompatibility,
  type ResolvedMemoryExecutionTarget
} from "../lib/server/memory/execution";
import {
  MEMORY_SEMANTIC_SMOKE_HISTORY_SEARCH_CODES,
  MEMORY_SEMANTIC_SMOKE_SCENARIOS,
  MemorySemanticSmokePreflightError,
  assessMemorySemanticSmokeHistorySearch,
  assessMemorySemanticSmokeSecretCommand,
  createMemorySemanticSmokeScenarioLedger,
  createPrismaMemorySemanticSmokeVerifier,
  memorySemanticSmokeRerankerReady,
  preflightPrismaMemorySemanticSmoke,
  readCgroupResourceLimits,
  validateMemorySemanticSmokeConsumerPreparation,
  validateMemorySemanticSmokePreflight,
  type MemorySemanticSmokePreflightSnapshot
} from "./memory-semantic-smoke-support";

const binding = Object.freeze({
  connectionId: "private-connection",
  credentialId: "private-credential",
  credentialVersionId: "private-credential-version",
  providerModelId: "private-system-model"
});

function snapshot(
  overrides: Partial<MemorySemanticSmokePreflightSnapshot> = {}
): MemorySemanticSmokePreflightSnapshot {
  return {
    answer: binding,
    credentialIntegrity: true,
    embeddingReady: true,
    embeddingSelected: true,
    rerankerReady: true,
    settingsAvailable: true,
    settingsEnabled: true,
    system: { ...binding, strictOutput: true, toolCalling: true },
    systemRolesReady: true,
    ...overrides
  };
}

function preflightCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof MemorySemanticSmokePreflightError ? error.code : null;
  }
}

function consumerSettings(
  overrides: Readonly<{
    capabilities?: Partial<MemoryConsumerSettingsResponse["capabilities"]>;
    resetState?: MemoryConsumerSettingsResponse["resetState"];
    settings?: Partial<MemoryConsumerSettingsResponse["settings"]>;
    status?: MemoryConsumerSettingsResponse["status"];
  }> = {}
): MemoryConsumerSettingsResponse {
  return {
    capabilities: {
      automaticLearningAvailable: true,
      decayAvailable: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      permanentChatDeletion: true,
      retrievalAvailable: true,
      temporaryChats: true,
      ...overrides.capabilities
    },
    resetState: overrides.resetState ?? "IDLE",
    settings: {
      decayEnabled: false,
      learnAutomatically: true,
      referenceChatHistory: true,
      useMemoryFacts: true,
      ...overrides.settings
    },
    status: overrides.status ?? "ON"
  };
}

function strictExecutionSnapshot(
  role: "MEMORY_CONTROL" | "MEMORY_QUERY_EMBED" | "MEMORY_RERANK"
) {
  const target: ResolvedMemoryExecutionTarget = {
    authority: {
      connectionId: "private-connection",
      connectionVersion: 1,
      credentialId: "private-credential",
      credentialVersionId: "private-credential-version",
      modelVersion: 1,
      providerModelId: "private-system-model"
    },
    compatibilityFingerprints: {
      configFingerprint: "1".repeat(64),
      deploymentFingerprint: "2".repeat(64),
      modelFingerprint: "3".repeat(64),
      providerFingerprint: "4".repeat(64)
    },
    credentialSource: "default",
    destinationFingerprint: "5".repeat(64),
    executionTargetFingerprint: "6".repeat(64),
    policyRevision: 1,
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "Private connection",
      connectionId: "private-connection",
      credentialId: "private-credential",
      credentialVersionId: "private-credential-version",
      model: role === "MEMORY_QUERY_EMBED"
        ? {
            adapterKind: "openai_embeddings_compatible",
            answerSelectable: false,
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              toolCalling: false,
              vision: false
            },
            defaultParams: {},
            embedding: {
              nativeDimension: 4_096,
              providerFamily: "openai_compatible",
              queryInstructionTemplate: null,
              supportsMrl: true,
              targetDimension: 1_536
            },
            modelClass: "embedding",
            upstreamModelId: "private-embedding-model"
          }
        : {
            adapterKind: "openai_responses_compatible",
            answerSelectable: true,
            capabilities: {
              forcedToolCalling: true,
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              structuredOutput: true,
              toolCalling: true,
              vision: false
            },
            defaultParams: {},
            modelClass: "answer",
            upstreamModelId: "private-upstream-model"
          },
      modelDisplayName: "Private system model",
      providerFamily: "openai_compatible",
      providerModelId: "private-system-model",
      version: 1
    }
  };
  const versions = {
    pipelineVersion: "pipeline-v1",
    policyVersion: "policy-v1",
    promptVersion: "prompt-v1",
    retrievalConfigFingerprint: "retrieval-v1",
    schemaVersion: "schema-v1"
  };
  const compatibility = resolveMemoryExecutionCompatibility({ role, target, versions });
  return createMemoryExecutionSnapshot({
    acceptedUtilityEgressFingerprint: "7".repeat(64),
    compatibilityId: compatibility.compatibilityId,
    compatibilityRequirement: compatibility.requirement,
    requiresStrictStructuredOutput: compatibility.requiresStrictStructuredOutput,
    role,
    target,
    utilityPolicyVersion: "memory-utility-egress-v2"
  });
}

const historySearchInput = Object.freeze({
  irrelevant: { chatId: "irrelevant-chat", messageId: "irrelevant-message" },
  recallModelRunId: "private-recall-run",
  relevant: { chatId: "relevant-chat", messageId: "relevant-message" },
  userId: "private-owner"
});

function searchResult(overrides: Record<string, unknown>) {
  return {
    exactItemId: "item",
    factVersionId: null,
    featureSnapshot: { finalScore: 0.1 },
    includedText: "private evidence",
    itemType: "RECALL_CHUNK",
    recallChunkId: null,
    recallRoundId: null,
    selectionReason: "rrf+semantic_sort.direct_relevance",
    sourceBranchGenerationSnapshot: 3,
    sourceChatId: null,
    sourceContentHashSnapshot: null,
    sourceMessageIds: [],
    sourceRevisionSnapshot: 5,
    ...overrides
  };
}

function historySearchClient(input: Readonly<{
  bindings: Partial<Record<"MEMORY_QUERY_EMBED" | "MEMORY_RERANK", unknown[]>>;
  calls?: readonly Readonly<{ id: string; state: string }>[];
  receipt?: Readonly<Record<string, unknown>>;
}>) {
  const chunkByChat: Record<string, string> = {
    "irrelevant-chat": "irrelevant-chunk",
    "relevant-chat": "relevant-chunk"
  };
  return {
    chat: {
      findFirst: vi.fn().mockResolvedValue({
        memoryBranchGeneration: 3,
        memorySourceRevision: 5
      })
    },
    memoryExecutionBinding: {
      findMany: vi.fn().mockImplementation(({ where }: {
        where: { logicalRole: "MEMORY_QUERY_EMBED" | "MEMORY_RERANK" };
      }) => Promise.resolve((input.bindings[where.logicalRole] ?? []).map((snapshot) => ({
        secretFreeExecutionSnapshot: snapshot
      }))))
    },
    memoryHistoryRun: {
      findMany: vi.fn().mockResolvedValue([{
        executionBindingIds: ["embed-binding", "rerank-binding"],
        indexingEvidence: { delivered: true },
        modelRunToolCallId: "search-call",
        outcome: "RESULTS",
        results: {
          version: "memory-search-v1",
          results: [
            searchResult({
              exactItemId: "relevant-chunk",
              featureSnapshot: { finalScore: 0.9 },
              recallChunkId: "relevant-chunk",
              sourceChatId: "relevant-chat"
            }),
            searchResult({
              exactItemId: "irrelevant-round",
              featureSnapshot: { finalScore: 0.4 },
              itemType: "RECALL_ROUND",
              recallRoundId: "irrelevant-round",
              sourceChatId: "irrelevant-chat"
            }),
            searchResult({
              exactItemId: "unrelated-fact",
              factVersionId: "unrelated-fact",
              featureSnapshot: { finalScore: 0.95 },
              itemType: "FACT_VERSION"
            })
          ]
        },
        retentionState: "RETAINED",
        state: "COMPLETE",
        ...input.receipt
      }])
    },
    memoryRecallChunk: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id }))))
    },
    memoryRecallChunkMessage: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { chatId: string } }) =>
        Promise.resolve([{ chunkId: chunkByChat[where.chatId] }]))
    },
    memoryRecallRound: {
      findMany: vi.fn().mockResolvedValue([{
        chatId: "irrelevant-chat",
        id: "irrelevant-round",
        parentChunkId: "irrelevant-chunk"
      }])
    },
    modelRunToolCall: {
      findMany: vi.fn().mockResolvedValue(input.calls ?? [{ id: "search-call", state: "complete" }])
    }
  } as unknown as PrismaClient & Readonly<{
    memoryExecutionBinding: { findMany: ReturnType<typeof vi.fn> };
    memoryHistoryRun: { findMany: ReturnType<typeof vi.fn> };
    memoryRecallChunk: { findMany: ReturnType<typeof vi.fn> };
    memoryRecallRound: { findMany: ReturnType<typeof vi.fn> };
    modelRunToolCall: { findMany: ReturnType<typeof vi.fn> };
  }>;
}

describe("Memory semantic smoke support", () => {
  it("allows only shared active-index readiness to be repaired after the mutation-free gate", () => {
    expect(validateMemorySemanticSmokeConsumerPreparation(consumerSettings()))
      .toEqual({ ok: true, retrievalReady: true });
    expect(validateMemorySemanticSmokeConsumerPreparation(consumerSettings({
      capabilities: { retrievalAvailable: false },
      status: "UNAVAILABLE"
    }))).toEqual({ ok: true, retrievalReady: false });
    expect(validateMemorySemanticSmokeConsumerPreparation(consumerSettings({
      capabilities: {
        automaticLearningAvailable: false,
        pastChatIndexingAvailable: false,
        retrievalAvailable: false
      },
      status: "UNAVAILABLE"
    }))).toEqual({ ok: true, retrievalReady: false });

    for (const unavailable of [
      consumerSettings({ capabilities: { automaticLearningAvailable: false } }),
      consumerSettings({ capabilities: { naturalLanguageActionsAvailable: false } }),
      consumerSettings({ capabilities: { pastChatIndexingAvailable: false } }),
      consumerSettings({ resetState: "IN_PROGRESS" }),
      consumerSettings({ status: "NEEDS_ADMIN_SETUP" })
    ]) {
      expect(validateMemorySemanticSmokeConsumerPreparation(unavailable)).toEqual({
        code: "memory_smoke_consumer_capability_unavailable",
        ok: false
      });
    }
    expect(validateMemorySemanticSmokeConsumerPreparation(consumerSettings({
      settings: { useMemoryFacts: false },
      status: "PAUSED"
    }))).toEqual({ code: "memory_smoke_settings_disabled", ok: false });
  });

  it("accepts an independently bound resolved reranker target", () => {
    const reranker = {
      authority: {
        connectionId: "reranker-connection",
        credentialId: "reranker-credential",
        credentialVersionId: "reranker-credential-version",
        providerModelId: "reranker-model"
      }
    } as ResolvedMemoryExecutionTarget;
    expect(memorySemanticSmokeRerankerReady(reranker)).toBe(true);
    expect(memorySemanticSmokeRerankerReady(undefined)).toBe(false);
  });

  it("fails missing embedding and strict-output setup before returning a target", () => {
    expect(preflightCode(() => validateMemorySemanticSmokePreflight(snapshot({
      embeddingSelected: false
    })))).toBe("memory_smoke_embedding_not_configured");
    expect(preflightCode(() => validateMemorySemanticSmokePreflight(snapshot({
      system: { ...binding, strictOutput: false, toolCalling: true }
    })))).toBe("memory_smoke_strict_output_unavailable");
  });

  it("fails a missing per-user embedding before opening the policy transaction", async () => {
    const client = {
      $transaction: vi.fn(),
      userMemorySettings: {
        findUnique: vi.fn().mockResolvedValue({
          acceptedUtilityEgressAt: null,
          acceptedUtilityEgressFingerprint: null,
          acceptedUtilityPolicyVersion: null,
          embeddingProviderModelId: null,
          learnAutomatically: true,
          referenceChatHistory: true,
          useMemoryFacts: true,
          userId: "private-owner"
        })
      }
    } as unknown as PrismaClient;

    await expect(preflightPrismaMemorySemanticSmoke(
      client,
      "private-owner",
      Buffer.alloc(32)
    )).rejects.toMatchObject({ code: "memory_smoke_embedding_not_configured" });
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("locks the executable PRD scenario manifest and rejects incomplete evidence", () => {
    expect(MEMORY_SEMANTIC_SMOKE_SCENARIOS).toEqual([
      "intent_without_exact_keywords",
      "update_target_selection",
      "forget_target_selection",
      "plain_language_secret_rejection",
      "conservative_extraction",
      "relevant_rerank",
      "irrelevant_rerank",
      "russian",
      "english",
      "mixed_language",
      "strict_structured_output"
    ]);
    const ledger = createMemorySemanticSmokeScenarioLedger();
    expect(() => ledger.assertComplete()).toThrow("memory_smoke_scenario_incomplete");
    for (const scenario of MEMORY_SEMANTIC_SMOKE_SCENARIOS) ledger.complete(scenario);
    expect(ledger.assertComplete()).toBe(MEMORY_SEMANTIC_SMOKE_SCENARIOS.length);
  });

  it("requires the bootstrap answer run to use the exact configured System binding", () => {
    expect(preflightCode(() => validateMemorySemanticSmokePreflight(snapshot({
      answer: { ...binding, credentialVersionId: "substituted-version" }
    })))).toBe("memory_smoke_answer_binding_mismatch");
    expect(validateMemorySemanticSmokePreflight(snapshot())).toEqual({
      connectionId: binding.connectionId,
      modelId: binding.providerModelId
    });
  });

  it("reports unreadable credentials with a fixed sanitized code", () => {
    expect(preflightCode(() => validateMemorySemanticSmokePreflight(snapshot({
      credentialIntegrity: false
    })))).toBe("memory_smoke_credential_unreadable");
  });

  it("derives actual cgroup-v2 limits and omits unbounded limits", () => {
    const values = new Map([
      ["/sys/fs/cgroup/cpu.max", "400000 100000\n"],
      ["/sys/fs/cgroup/memory.max", String(3 * 2 ** 30)]
    ]);
    expect(readCgroupResourceLimits((path) => values.get(path) ?? null)).toEqual({
      cpu: 4,
      memoryGiB: 3
    });
    expect(readCgroupResourceLimits((path) => path.endsWith("cpu.max")
      ? "max 100000"
      : path.endsWith("memory.max") ? "max" : null)).toBeNull();
  });

  it("proves an automatic recall through exact owner, source, fact, and attempt bindings", async () => {
    const client = {
      memoryEvidence: {
        findMany: vi.fn().mockResolvedValue([{ factVersionId: "private-version" }])
      },
      memoryFact: {
        findMany: vi.fn().mockResolvedValue([{ currentVersionId: "private-version" }])
      },
      memoryFactVersion: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-version" }])
      },
      memoryRetrievalAttempt: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-attempt" }])
      },
      memoryRetrievalAttemptItem: {
        count: vi.fn().mockResolvedValue(1)
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);
    const notBefore = new Date("2026-08-21T10:00:00.000Z");

    await expect(verifier.recalledAutomaticFactCount({
      chatId: "private-source-chat",
      messageId: "private-source-message",
      notBefore,
      recallModelRunId: "private-recall-run",
      userId: "private-owner"
    })).resolves.toBe(1);

    expect(client.memoryEvidence.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        chatId: "private-source-chat",
        createdAt: { gte: notBefore },
        messageId: "private-source-message",
        sourceRole: "user",
        userId: "private-owner"
      })
    }));
    expect(client.memoryRetrievalAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        modelRunId: "private-recall-run",
        outcome: "USED",
        state: "CONSUMED",
        userId: "private-owner"
      }
    }));
    expect(client.memoryRetrievalAttemptItem.count).toHaveBeenCalledWith({
      where: {
        attemptId: { in: ["private-attempt"] },
        factVersionId: { in: ["private-version"] },
        itemType: "FACT_VERSION",
        userId: "private-owner"
      }
    });
  });

  it("waits for a source-bound automatic fact in the active ready vector generation", async () => {
    const client = {
      memoryEvidence: {
        findMany: vi.fn().mockResolvedValue([{ factVersionId: "private-version" }])
      },
      memoryFact: {
        findMany: vi.fn().mockResolvedValue([{ currentVersionId: "private-version" }])
      },
      memoryFactVersion: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-version" }])
      },
      memorySearchEntry: {
        count: vi.fn().mockResolvedValue(1)
      },
      userMemorySettings: {
        findUnique: vi.fn().mockResolvedValue({
          activeIndexGenerationId: "private-generation"
        })
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);
    const notBefore = new Date("2026-08-21T10:00:00.000Z");

    await expect(verifier.sourceBackedFactEmbeddingReadyCount({
      chatId: "private-source-chat",
      messageId: "private-source-message",
      notBefore,
      userId: "private-owner"
    })).resolves.toBe(1);
    expect(client.memorySearchEntry.count).toHaveBeenCalledWith({
      where: {
        embeddingState: "READY",
        factVersionId: { in: ["private-version"] },
        indexGenerationId: "private-generation",
        itemType: "FACT_VERSION",
        userId: "private-owner"
      }
    });
  });

  it("counts only current explicit facts with ready active-generation embeddings", async () => {
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ count: 2 }]),
      userMemorySettings: {
        findUnique: vi.fn().mockResolvedValue({
          activeIndexGenerationId: "private-generation"
        })
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.readyExplicitFactEmbeddingCount({
      query: "private marker",
      userId: "private-owner"
    })).resolves.toBe(2);
    expect(client.userMemorySettings.findUnique).toHaveBeenCalledWith({
      select: { activeIndexGenerationId: true },
      where: { userId: "private-owner" }
    });
    expect(client.$queryRaw).toHaveBeenCalledOnce();
  });

  it("waits for indexed history only through the current exact source chunk", async () => {
    const client = {
      chat: {
        findFirst: vi.fn().mockResolvedValue({
          memoryBranchGeneration: 3,
          memorySourceRevision: 5
        })
      },
      memoryIndexGeneration: {
        findFirst: vi.fn().mockResolvedValue({ id: "private-generation" })
      },
      memoryRecallChunk: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-chunk" }])
      },
      memoryRecallChunkMessage: {
        findMany: vi.fn().mockResolvedValue([{ chunkId: "private-chunk" }])
      },
      memorySearchEntry: {
        findMany: vi.fn().mockResolvedValue([{ recallChunkId: "private-chunk" }])
      },
      userMemorySettings: {
        findUnique: vi.fn().mockResolvedValue({
          activeIndexGenerationId: "private-generation",
          embeddingProviderModelId: "private-embedding"
        })
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.indexedHistorySourceCount({
      chatId: "private-source-chat",
      messageId: "private-source-message",
      userId: "private-owner"
    })).resolves.toBe(1);

    expect(client.chat.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "private-source-chat",
        memoryMode: "NORMAL",
        projectId: null,
        userId: "private-owner"
      }
    }));
    expect(client.memoryRecallChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        branchGeneration: 3,
        sourceRevisionAtCreation: 5,
        userId: "private-owner"
      })
    }));
    expect(client.memorySearchEntry.findMany).toHaveBeenCalledWith({
      distinct: ["recallChunkId"],
      select: { recallChunkId: true },
      where: {
        embeddingState: "READY",
        indexGenerationId: "private-generation",
        itemType: "RECALL_CHUNK",
        recallChunkId: { in: ["private-chunk"] },
        userId: "private-owner"
      }
    });
  });

  it("proves history recall only through delivered memory_search receipts of the exact sources", async () => {
    const embed = strictExecutionSnapshot("MEMORY_QUERY_EMBED");
    const rerank = strictExecutionSnapshot("MEMORY_RERANK");
    const client = historySearchClient({
      bindings: { MEMORY_QUERY_EMBED: [embed], MEMORY_RERANK: [rerank] }
    });
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    const evidence = await verifier.historySearchEvidence(historySearchInput);
    expect(evidence).toEqual({
      calls: 1,
      irrelevantResults: 1,
      irrelevantTopScore: 0.4,
      queryEmbedExecutions: 1,
      receipts: 1,
      relevantResults: 1,
      relevantSemanticallySorted: 1,
      relevantTopScore: 0.9,
      rerankExecutions: 1,
      unhealthy: 0
    });
    expect(assessMemorySemanticSmokeHistorySearch(evidence)).toEqual({ ok: true });

    expect(client.modelRunToolCall.findMany).toHaveBeenCalledWith({
      select: { id: true, state: true },
      where: {
        modelRun: { userId: "private-owner" },
        modelRunId: "private-recall-run",
        toolName: "memory_search"
      }
    });
    expect(client.memoryHistoryRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { modelRunId: "private-recall-run", userId: "private-owner" }
    }));
    expect(client.memoryRecallChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        branchGeneration: 3,
        chatId: "relevant-chat",
        sourceRevisionAtCreation: 5,
        userId: "private-owner"
      })
    }));
    expect(client.memoryRecallRound.findMany).toHaveBeenCalledWith({
      select: { chatId: true, id: true, parentChunkId: true },
      where: { id: { in: ["irrelevant-round"] }, userId: "private-owner" }
    });
    for (const logicalRole of ["MEMORY_QUERY_EMBED", "MEMORY_RERANK"]) {
      expect(client.memoryExecutionBinding.findMany).toHaveBeenCalledWith({
        select: { secretFreeExecutionSnapshot: true },
        where: {
          id: { in: ["embed-binding", "rerank-binding"] },
          logicalRole,
          modelRunId: "private-recall-run",
          modelRunToolCallId: { in: ["search-call"] },
          ownerType: "MODEL_RUN_TOOL_CALL",
          state: "SUCCEEDED",
          userId: "private-owner"
        }
      });
    }
  });

  it("does not count undelivered, degraded or receipt-less searches as history evidence", async () => {
    const client = historySearchClient({
      bindings: {},
      calls: [
        { id: "search-call", state: "complete" },
        { id: "malformed-call", state: "error" }
      ],
      receipt: { indexingEvidence: { delivered: false }, outcome: "DEGRADED" }
    });
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    const evidence = await verifier.historySearchEvidence(historySearchInput);
    expect(evidence).toMatchObject({
      calls: 2,
      queryEmbedExecutions: 0,
      receipts: 1,
      relevantResults: 0,
      rerankExecutions: 0,
      unhealthy: 2
    });
    expect(client.memoryExecutionBinding.findMany).not.toHaveBeenCalled();
    expect(assessMemorySemanticSmokeHistorySearch(evidence)).toEqual({
      code: "memory_smoke_history_search_degraded",
      ok: false
    });
  });

  it("assigns distinct stable codes to each missing history-search proof", () => {
    const healthy = {
      calls: 1,
      irrelevantResults: 0,
      irrelevantTopScore: null,
      queryEmbedExecutions: 1,
      receipts: 1,
      relevantResults: 1,
      relevantSemanticallySorted: 1,
      relevantTopScore: 0.8,
      rerankExecutions: 1,
      unhealthy: 0
    };
    const code = (overrides: Partial<typeof healthy> | Record<string, unknown>) => {
      const assessed = assessMemorySemanticSmokeHistorySearch({ ...healthy, ...overrides });
      return assessed.ok ? null : assessed.code;
    };
    expect(code({})).toBeNull();
    expect(code({ calls: 0, receipts: 0 })).toBe("memory_smoke_history_search_not_called");
    expect(code({ receipts: 0 })).toBe("memory_smoke_history_search_not_called");
    expect(code({ unhealthy: 1 })).toBe("memory_smoke_history_search_degraded");
    expect(code({ queryEmbedExecutions: 0 })).toBe(
      "memory_smoke_history_search_embedding_missing"
    );
    expect(code({ relevantResults: 0 })).toBe("memory_smoke_history_recall_failed");
    expect(code({ rerankExecutions: 0 })).toBe("memory_smoke_irrelevant_rerank_failed");
    expect(code({ relevantSemanticallySorted: 0 })).toBe(
      "memory_smoke_irrelevant_rerank_failed"
    );
    expect(code({ irrelevantResults: 1, irrelevantTopScore: 0.8 })).toBe(
      "memory_smoke_irrelevant_rerank_failed"
    );
    expect(code({ irrelevantResults: 1, irrelevantTopScore: null })).toBe(
      "memory_smoke_irrelevant_rerank_failed"
    );
    expect(code({ irrelevantResults: 1, irrelevantTopScore: 0.5 })).toBeNull();
    expect(MEMORY_SEMANTIC_SMOKE_HISTORY_SEARCH_CODES).toHaveLength(5);
  });

  it("accepts a rejected secret save or a token-free safe remainder only", () => {
    const evidence = {
      mutationRows: 0,
      operation: "SAVE",
      persistedVersions: 0,
      status: "REJECTED",
      tokenBearingVersions: 0,
      unsafeVersions: 0
    };
    const assess = (overrides: Partial<typeof evidence>) =>
      assessMemorySemanticSmokeSecretCommand({ ...evidence, ...overrides });
    expect(assess({})).toEqual({ ok: true, outcome: "rejected" });
    expect(assess({ mutationRows: 1 })).toEqual({
      code: "memory_smoke_secret_persisted", ok: false
    });
    const committed = { mutationRows: 2, persistedVersions: 1, status: "COMMITTED" };
    expect(assess(committed)).toEqual({ ok: true, outcome: "safe_remainder" });
    expect(assess({ ...committed, tokenBearingVersions: 1 })).toEqual({
      code: "memory_smoke_secret_persisted", ok: false
    });
    expect(assess({ ...committed, unsafeVersions: 1 })).toEqual({
      code: "memory_smoke_secret_persisted", ok: false
    });
    expect(assess({ ...committed, persistedVersions: 0 })).toEqual({
      code: "memory_smoke_secret_rejection_failed", ok: false
    });
    for (const overrides of [
      { operation: "UNKNOWN" },
      { operation: "UPDATE", status: "COMMITTED" },
      { status: "FAILED" },
      { status: "UNKNOWN" }
    ]) {
      expect(assess(overrides)).toEqual({ code: "memory_smoke_secret_rejection_failed", ok: false });
    }
  });

  it("finds secret-command versions through the exact command receipt and checks the token", async () => {
    const client = {
      memoryFactVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            displayText: "Demonstration account password exists",
            normalizedSearchText: "demonstration account password exists",
            safetyClassificationState: "CLASSIFIED",
            semanticFrame: null,
            sensitivityClass: "NORMAL",
            structuredValue: null
          },
          {
            displayText: "Safe",
            normalizedSearchText: "safe",
            safetyClassificationState: "CLASSIFIED",
            semanticFrame: { value: "Blue-Orchard-abcdefghijkl" },
            sensitivityClass: "NORMAL",
            structuredValue: null
          },
          {
            displayText: "Safe",
            normalizedSearchText: "safe",
            safetyClassificationState: "SECRET_FENCED",
            semanticFrame: null,
            sensitivityClass: "NORMAL",
            structuredValue: null
          }
        ])
      },
      memoryJob: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-command-job" }])
      },
      memoryOperationReceipt: {
        findMany: vi.fn().mockResolvedValue([
          { targetVersionId: "version-1" },
          { targetVersionId: "version-2" },
          { targetVersionId: "version-3" },
          { targetVersionId: null }
        ])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.secretCommandVersionCounts({
      chatId: "private-chat",
      messageId: "private-message",
      modelRunId: "private-run",
      token: "blue-orchard-abcdefghijkl",
      userId: "private-owner"
    })).resolves.toEqual({ persistedVersions: 3, tokenBearingVersions: 1, unsafeVersions: 1 });
    expect(client.memoryOperationReceipt.findMany).toHaveBeenCalledWith({
      select: { targetVersionId: true },
      where: {
        OR: [
          { requestId: { in: ["command-v1:private-command-job"] } },
          { modelRunId: "private-run" }
        ],
        outcome: "APPLIED",
        userId: "private-owner"
      }
    });
    expect(client.memoryFactVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["version-1", "version-2", "version-3"] }, userId: "private-owner" }
    }));
  });

  it("binds natural-language command control to the exact source message's command job", async () => {
    const strictControl = strictExecutionSnapshot("MEMORY_CONTROL");
    const client = {
      memoryExecutionBinding: {
        findMany: vi.fn().mockResolvedValue([{ secretFreeExecutionSnapshot: strictControl }])
      },
      memoryJob: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-command-job" }])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.successfulCommandControlCount({
      chatId: "private-chat",
      messageId: "private-message",
      userId: "private-owner"
    })).resolves.toBe(1);
    expect(client.memoryJob.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        chatId: "private-chat",
        kind: "MEMORY_COMMAND",
        sourceMessageId: "private-message",
        userId: "private-owner"
      }
    });
    expect(client.memoryExecutionBinding.findMany).toHaveBeenCalledWith({
      select: { secretFreeExecutionSnapshot: true },
      where: {
        logicalRole: "MEMORY_CONTROL",
        memoryJobId: { in: ["private-command-job"] },
        state: "SUCCEEDED",
        userId: "private-owner"
      }
    });
  });

  it("accepts strict retry-ancestor evidence only beside a consumed attempt", async () => {
    const strictControl = strictExecutionSnapshot("MEMORY_CONTROL");
    const rerank = strictExecutionSnapshot("MEMORY_RERANK");
    const client = {
      memoryExecutionBinding: {
        findMany: vi.fn()
          .mockResolvedValueOnce([{ secretFreeExecutionSnapshot: strictControl }])
          .mockResolvedValueOnce([{ secretFreeExecutionSnapshot: rerank }])
      },
      memoryMutationAuthorization: { count: vi.fn().mockResolvedValue(0) },
      memoryOperationReceipt: { count: vi.fn().mockResolvedValue(0) },
      memoryRetrievalAttempt: {
        findMany: vi.fn().mockResolvedValue([
          { errorCode: null, id: "private-attempt", state: "CONSUMED" },
          {
            errorCode: "memory_admission_settings_changed",
            id: "private-retry-ancestor",
            state: "STALE"
          },
          { errorCode: "memory_admission_dag_changed", id: "private-stale", state: "STALE" }
        ])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.successfulRetrievalExecutionCount({
      modelRunId: "private-run",
      role: "MEMORY_CONTROL",
      userId: "private-owner"
    })).resolves.toBe(1);
    await expect(verifier.successfulRetrievalExecutionCount({
      modelRunId: "private-run",
      role: "MEMORY_RERANK",
      userId: "private-owner"
    })).resolves.toBe(1);
    await expect(verifier.mutationPersistenceCount({
      modelRunId: "private-run",
      userId: "private-owner"
    })).resolves.toBe(0);

    expect(client.memoryExecutionBinding.findMany).toHaveBeenNthCalledWith(1, {
      select: { secretFreeExecutionSnapshot: true },
      where: {
        logicalRole: "MEMORY_CONTROL",
        retrievalAttemptId: { in: ["private-attempt", "private-retry-ancestor"] },
        state: "SUCCEEDED",
        userId: "private-owner"
      }
    });
    expect(client.memoryExecutionBinding.findMany).toHaveBeenNthCalledWith(2, {
      select: { secretFreeExecutionSnapshot: true },
      where: {
        logicalRole: "MEMORY_RERANK",
        retrievalAttemptId: { in: ["private-attempt", "private-retry-ancestor"] },
        state: "SUCCEEDED",
        userId: "private-owner"
      }
    });
    expect(client.memoryMutationAuthorization.count).toHaveBeenCalledWith({
      where: { modelRunId: "private-run", userId: "private-owner" }
    });
    expect(client.memoryRetrievalAttempt.findMany).toHaveBeenCalledWith({
      select: { errorCode: true, id: true, state: true },
      where: {
        modelRunId: "private-run",
        state: { in: ["CONSUMED", "STALE"] },
        userId: "private-owner"
      }
    });
  });

  it("does not treat a stale-only run as successful provider evidence", async () => {
    const client = {
      memoryExecutionBinding: { findMany: vi.fn() },
      memoryRetrievalAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          errorCode: "memory_admission_settings_changed",
          id: "private-retry-ancestor",
          state: "STALE"
        }])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.successfulRetrievalExecutionCount({
      modelRunId: "private-run",
      role: "MEMORY_CONTROL",
      userId: "private-owner"
    })).resolves.toBe(0);
    expect(client.memoryExecutionBinding.findMany).not.toHaveBeenCalled();
  });

  it("detects any exact source-backed fact evidence before claiming secret rejection", async () => {
    const client = {
      memoryEvidence: { count: vi.fn().mockResolvedValue(0) }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);
    const notBefore = new Date("2026-08-21T10:00:00.000Z");

    await expect(verifier.sourceBackedFactVersionCount({
      chatId: "private-source-chat",
      messageId: "private-source-message",
      notBefore,
      userId: "private-owner"
    })).resolves.toBe(0);
    expect(client.memoryEvidence.count).toHaveBeenCalledWith({
      where: {
        chatId: "private-source-chat",
        createdAt: { gte: notBefore },
        messageId: "private-source-message",
        sourceRole: "user",
        sourceType: "MESSAGE",
        userId: "private-owner"
      }
    });
  });

  it("treats only the latest unrecoverable source execution as terminally unsuccessful", async () => {
    const client = {
      memoryExecutionBinding: {
        findMany: vi.fn().mockResolvedValue([
          { memoryJobId: "job-ok", ordinal: 0, state: "SUCCEEDED" },
          { memoryJobId: "job-unknown", ordinal: 0, state: "OUTCOME_UNKNOWN" },
          { memoryJobId: "job-retried", ordinal: 0, state: "FAILED" },
          { memoryJobId: "job-retried", ordinal: 1, state: "SUCCEEDED" }
        ])
      },
      memoryJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "job-ok",
            kind: "EXTRACT_FACTS",
            stage: "fact_observations_empty",
            state: "SUCCEEDED"
          },
          { id: "job-unknown", kind: "INDEX_HISTORY", stage: null, state: "SUCCEEDED" },
          { id: "job-retried", kind: "INDEX_HISTORY", stage: null, state: "SUCCEEDED" },
          {
            errorCode: "memory_fact_source_command_excluded",
            id: "job-command-fenced",
            kind: "EXTRACT_FACTS",
            stage: null,
            state: "CANCELLED"
          },
          {
            errorCode: "memory_source_stale",
            id: "job-stale-extraction",
            kind: "EXTRACT_FACTS",
            stage: null,
            state: "CANCELLED"
          }
        ])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    // The command fence still counts as terminal, so learned-fact waits fail
    // fast; only the no-fact wait subtracts the separately reported fence.
    await expect(verifier.sourceJobStateCounts({
      chatId: "private-source-chat",
      userId: "private-owner"
    })).resolves.toEqual({
      active: 0,
      commandExcludedExtractions: 1,
      successfulEmptyExtraction: true,
      total: 5,
      unsuccessfulTerminal: 3
    });
  });

  it("keeps the scenario manifest and retired control-plane APIs out of the smoke", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/smoke-memory-semantic-retrieval.ts"),
      "utf8"
    );
    expect(source).toContain('"/api/admin/memory"');
    expect(source).toContain('"/api/me/memory/settings"');
    expect(source).toContain("/api/me/memories?");
    expect(source).not.toMatch(/\/api\/me\/memory\/(?:health|rebuild)/u);
    expect(source).not.toMatch(/\/evidence(?:\?|["`])/u);
    expect(source).not.toMatch(/refresh_active|set_default_credential|create_group|create_invite/u);
    expect(source).not.toMatch(/adminMemoryEgressService|\/api\/admin\/memory\/egress/u);
    expect(source).not.toMatch(
      /\/api\/me\/memory\/settings[\s\S]{0,160}method:\s*"PATCH"/u
    );
    expect(source).toContain("/api/me/chats/${encodeURIComponent(chatId)}/memory-mode");
    // Natural-language commands are durable background work: outcomes come
    // from content-free command feedback, ambiguity is resolved in the Library.
    expect(source).toContain("/api/me/chats/${encodeURIComponent(source.chat.id)}/memory-commands");
    expect(source).not.toContain("/api/me/memory/source-actions");
    expect(source.match(/await requiredMemoryCommand\(/gu)).toHaveLength(5);
    expect(source.match(/await editConsumerMemory\(/gu)).toHaveLength(1);
    expect(source).toContain("assessMemorySemanticSmokeSecretCommand({");
    const noFactWait = source.slice(
      source.indexOf("async function waitForNoAutomaticFact("),
      source.indexOf("function memoryAction(")
    );
    expect(noFactWait).toContain(
      "jobs.unsuccessfulTerminal - jobs.commandExcludedExtractions > 0"
    );
    expect(source).toContain("await waitForNoAutomaticFact(secret, secretStartedAt);");
    expect(source).toContain(".includes(secretToken)");
    // Standing-v1 turns admit no dynamic history: recall must be proven
    // through the answer model's memory_search receipts.
    expect(source).not.toContain("recalledHistorySourceCount");
    expect(source).toContain(
      "Search your memory of our past conversations before answering. Для ${marker} aquarium launch"
    );
    expect(source).toContain("assessMemorySemanticSmokeHistorySearch(historySearch)");
    expect(source).toContain("memory_smoke_expected_fact_missing");
    expect(source).toContain('mcp: { mode: "off" }');
    expect(source).toContain('process.argv.includes("--actions-only")');
    expect(source).toContain('requiredManagementAction(list, "LIST", "COMPLETE")');
    expect(source).toContain(
      'requiredManagementAction(reset, "RESET", "CONFIRMATION_REQUIRED")'
    );
    expect(source).toContain("`Меня зовут Алина-${marker}");
    expect(source).toContain("identityAnswer.toLocaleLowerCase().includes(marker)");
    expect(source).toContain(
      "When I read answers, I prefer a concise response format called ${marker}-grid."
    );
    expect(source).not.toContain(
      "This named format is a stable long-term preference in every conversation."
    );
    const learnedFactLoop = source.slice(
      source.indexOf("async function waitForLearnedFact("),
      source.indexOf("async function waitForIndexedHistorySource(")
    );
    expect(learnedFactLoop).toContain("jobs.active === 0 && jobs.total > 0");
    expect(learnedFactLoop).toContain("sourceBackedFactVersionCount");
    expect(learnedFactLoop).toContain("sourceBackedFactEmbeddingReadyCount");
    expect(source).toContain("readyExplicitFactEmbeddingCount");
    const main = source.slice(source.indexOf("async function main(): Promise<void>"));
    expect(main.match(/await sourceRun\(/gu)).toHaveLength(13);
    expect(source).toContain("const MAX_CHAT_RUNS = 13;");
    expect(source).toContain("Memory smoke implicit save quarterly ${marker}");
    const consumerGate = main.indexOf("requireConsumerPreparation(settings);");
    const providerPreflight = main.indexOf("await preflightPrismaMemorySemanticSmoke(");
    const readiness = main.indexOf(
      "const rebuildActions = await ensureAdminMemoryReady(initialStatus, settings);"
    );
    const finalConsumerGate = main.indexOf(
      "assertConsumerSettingsReady(await consumerSettings());"
    );
    expect(consumerGate).toBeGreaterThanOrEqual(0);
    expect(providerPreflight).toBeGreaterThan(consumerGate);
    expect(readiness).toBeGreaterThan(providerPreflight);
    expect(finalConsumerGate).toBeGreaterThan(readiness);
    const readinessLoop = source.slice(
      source.indexOf("async function ensureAdminMemoryReady("),
      source.indexOf("async function createChat(")
    );
    expect(readinessLoop).toContain("requireConsumerPreparation(currentSettings)");
    expect(readinessLoop).toContain("consumerSettings(),");
    const historyReadinessLoop = source.slice(
      source.indexOf("async function waitForIndexedHistorySource("),
      source.indexOf("async function waitForConservativeExtraction(")
    );
    expect(historyReadinessLoop).toContain("requireConsumerPreparation(settings)");
    expect(historyReadinessLoop).not.toContain(
      'status.index.readiness === "READY"'
    );
    for (const scenario of MEMORY_SEMANTIC_SMOKE_SCENARIOS) {
      expect(source.match(new RegExp(`scenarios\\.complete\\("${scenario}"\\)`, "gu")))
        .toHaveLength(1);
    }
    const implicitPromptLines = source.split("\n").filter((line) =>
      line.includes("Please carry this preference into future conversations"));
    expect(implicitPromptLines).toHaveLength(4);
    expect(implicitPromptLines.join("\n")).not.toMatch(/\b(?:remember|save|store)\b/iu);
  });
});
