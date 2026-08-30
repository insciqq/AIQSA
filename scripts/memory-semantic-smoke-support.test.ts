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
  MEMORY_SEMANTIC_SMOKE_REQUIRED_ROLES,
  MEMORY_SEMANTIC_SMOKE_SCENARIOS,
  MemorySemanticSmokePreflightError,
  createMemorySemanticSmokeScenarioLedger,
  createPrismaMemorySemanticSmokeVerifier,
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
    consentAccepted: true,
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
      synthesisAvailable: true,
      temporaryChats: true,
      ...overrides.capabilities
    },
    resetState: overrides.resetState ?? "IDLE",
    settings: {
      decayEnabled: false,
      learnAutomatically: true,
      referenceChatHistory: true,
      synthesisEnabled: false,
      useMemoryFacts: true,
      ...overrides.settings
    },
    status: overrides.status ?? "ON"
  };
}

function strictExecutionSnapshot(role: "MEMORY_CONTROL" | "MEMORY_RERANK") {
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
      model: {
        adapterKind: "openai_responses_compatible",
        answerSelectable: true,
        capabilities: {
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

  it("preflights every provider role exercised by the semantic smoke", () => {
    expect(MEMORY_SEMANTIC_SMOKE_REQUIRED_ROLES).toEqual([
      "MEMORY_CONTROL",
      "MEMORY_STATEMENT_CLASSIFY",
      "MEMORY_HISTORY_CLASSIFY",
      "MEMORY_FACT_EXTRACT",
      "MEMORY_CONSOLIDATE",
      "MEMORY_RERANK",
      "MEMORY_DOCUMENT_EMBED",
      "MEMORY_QUERY_EMBED"
    ]);
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

  it("reports unreadable credentials and unaccepted egress as fixed sanitized codes", () => {
    expect(preflightCode(() => validateMemorySemanticSmokePreflight(snapshot({
      consentAccepted: false
    })))).toBe("memory_smoke_egress_not_accepted");
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

  it("proves vector recall only through the current exact source chunk", async () => {
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
      memoryRetrievalAttempt: {
        findMany: vi.fn().mockResolvedValue([{ id: "private-attempt" }])
      },
      memoryRetrievalAttemptItem: {
        count: vi.fn().mockResolvedValue(1)
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

    await expect(verifier.recalledHistorySourceCount({
      chatId: "private-source-chat",
      messageId: "private-source-message",
      recallModelRunId: "private-recall-run",
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
    expect(client.memoryRetrievalAttemptItem.count).toHaveBeenCalledWith({
      where: {
        attemptId: { in: ["private-attempt"] },
        itemType: "RECALL_CHUNK",
        recallChunkId: { in: ["private-chunk"] },
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
          { id: "job-retried", kind: "INDEX_HISTORY", stage: null, state: "SUCCEEDED" }
        ])
      }
    } as unknown as PrismaClient;
    const verifier = createPrismaMemorySemanticSmokeVerifier(client);

    await expect(verifier.sourceJobStateCounts({
      chatId: "private-source-chat",
      userId: "private-owner"
    })).resolves.toEqual({
      active: 0,
      successfulEmptyExtraction: true,
      total: 3,
      unsuccessfulTerminal: 1
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
    expect(source).toContain('"/api/me/memory/source-actions"');
    expect(source.match(/await commitMemoryTargetSelection\(/gu)).toHaveLength(2);
    expect(source).toContain('secretAction.operation !== "SAVE"');
    expect(source).toContain('secretAction.status !== "REJECTED"');
    expect(source).toContain("memory_smoke_expected_fact_missing");
    expect(source).toContain('mcp: { mode: "off" }');
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
    expect(implicitPromptLines).toHaveLength(3);
    expect(implicitPromptLines.join("\n")).not.toMatch(/\b(?:remember|save|store)\b/iu);
  });
});
