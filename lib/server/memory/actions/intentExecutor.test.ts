import { randomBytes } from "node:crypto";
import { memoryDetailFixture, memoryListFixture, memorySummaryFixture } from "@/tests/support/memoryFixtures";
import { describe, expect, it, vi } from "vitest";
import { createMemoryClientRefService } from "./clientRef";
import {
  memoryControlAcceptedOutputHash,
  memoryControlIntentHash
} from "./controlRuntime";
import { createMemoryIntentActionExecutor } from "./intentExecutor";
import type { MemoryActionTarget } from "./targetSearch";
import { memoryTargetAuthorizationPayloadHash } from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";

const now = new Date("2026-08-21T05:00:00.000Z");
const clientRefs = createMemoryClientRefService({ encryptionKey: () => randomBytes(32) });

function intent(overrides: Record<string, unknown> = {}) {
  return {
    action: "NONE",
    aggregationRequested: false,
    applyResponsePreferences: false,
    category: null,
    categoryHint: null,
    confidenceBand: "HIGH",
    memoryUseful: false,
    pastChatsUseful: false,
    queryText: null,
    reasonCode: "none",
    recencyRequested: false,
    referencedMemoryRef: null,
    replacementStatement: null,
    responsePreference: false,
    sensitiveDomainHint: null,
    sensitivity: "NORMAL",
    statement: null,
    targetQuery: null,
    thisChatOnly: false,
    ...overrides
  } as never;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const authorizationRepository = {
    mintForControl: vi.fn(async () => ({
      authorizedPayloadHash: "a".repeat(64),
      id: "authorization-1"
    }))
  };
  const explicitService = {
    create: vi.fn(async () => ({ memory: memorySummaryFixture({
      category: "preferences",
      displayText: "I prefer concise answers."
    }) })),
    get: vi.fn(async () => memoryDetailFixture()),
    list: vi.fn(async () => memoryListFixture()),
    search: vi.fn(async () => memoryListFixture()),
    update: vi.fn(async () => ({ memory: memorySummaryFixture({
      currentVersionId: "memory-version-2",
      displayText: "I prefer detailed answers."
    }) })),
    ...overrides
  };
  const lifecycleService = { forget: vi.fn(async () => ({})) };
  const target = actionTarget(memorySummaryFixture());
  const targetSearch = {
    exact: vi.fn(async () => ({ status: "READY" as const, targets: [] })),
    semantic: vi.fn(async () => ({ status: "READY" as const, targets: [target] }))
  };
  const targetSelector = {
    assertAuthorized: vi.fn(async () => undefined),
    assertControlAuthorized: vi.fn(async () => undefined),
    select: vi.fn(async () => ({
      reason: "memory_target_selector_unavailable",
      status: "UNAVAILABLE" as const
    }))
  };
  return {
    authorizationRepository,
    explicitService,
    lifecycleService,
    targetSearch,
    targetSelector
  };
}

function actionTarget(summary: ReturnType<typeof memorySummaryFixture>): MemoryActionTarget {
  if (!summary.currentVersionId || !summary.displayText) throw new Error("invalid fixture");
  return {
    factId: summary.id,
    statement: summary.displayText,
    summary,
    versionId: summary.currentVersionId
  };
}

function execution(actionIntent: ReturnType<typeof intent>) {
  return {
    admissionDeadlineAtMs: now.getTime() + 4_000,
    attemptId: "attempt-1",
    bindingId: "binding-1",
    chatId: "chat-1",
    currentUserText: "Remember that I prefer concise answers.",
    intent: actionIntent,
    modelRunId: "run-1",
    now,
    signal: new AbortController().signal,
    userId: "user-1"
  };
}

describe("Memory intent action executor", () => {
  it("changes durable control evidence when action or mutation payload is swapped", () => {
    const accepted = intent({
      action: "SAVE",
      reasonCode: "save_request",
      statement: "I prefer concise answers."
    });
    const inputHash = "a".repeat(64);
    const outputHash = memoryControlAcceptedOutputHash(
      inputHash,
      memoryControlIntentHash(accepted)
    );
    expect(memoryControlAcceptedOutputHash(inputHash, memoryControlIntentHash(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      targetQuery: "concise answers"
    })))).not.toBe(outputHash);
    expect(memoryControlAcceptedOutputHash(inputHash, memoryControlIntentHash(intent({
      action: "SAVE",
      reasonCode: "save_request",
      statement: "I prefer detailed answers."
    })))).not.toBe(outputHash);
    expect(memoryTargetAuthorizationPayloadHash({
      action: "EDIT",
      expectedTargetVersionId: "version-1",
      replacementStatementHash: memorySha256("I prefer concise answers."),
      targetFactId: "fact-1"
    })).not.toBe(memoryTargetAuthorizationPayloadHash({
      action: "EDIT",
      expectedTargetVersionId: "version-1",
      replacementStatementHash: memorySha256("I prefer detailed answers."),
      targetFactId: "fact-1"
    }));
  });

  it("commits an authorized HIGH-confidence save and returns only an opaque ref", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "SAVE",
      category: "preferences",
      reasonCode: "save_request",
      responsePreference: true,
      statement: "I prefer concise answers."
    })));
    expect(result).toMatchObject({
      operation: "SAVE",
      statement: "I prefer concise answers.",
      status: "COMMITTED"
    });
    expect(result).not.toHaveProperty("factId");
    expect(result?.memoryRef).not.toContain("memory-version-1");
    expect(deps.targetSelector.assertControlAuthorized).toHaveBeenCalledWith({
      bindingId: "binding-1",
      userId: "user-1"
    });
    expect(deps.authorizationRepository.mintForControl).toHaveBeenCalledTimes(1);
    expect(deps.explicitService.create).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ category: "preferences", modality: "PREFERENCE" }),
      expect.objectContaining({ persistedToolCallId: null })
    );
  });

  it("persists legacy SENSITIVE control output as ordinary memory", async () => {
    const deps = dependencies();
    await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "SAVE",
      category: "sensitive",
      categoryHint: "about_you",
      reasonCode: "save_request",
      sensitivity: "SENSITIVE",
      statement: "The user lives in Rostov."
    })));

    expect(deps.explicitService.create).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ category: "about_you" }),
      expect.objectContaining({ sensitivityClass: "NORMAL" })
    );
  });

  it("does not persist a this-chat-only request", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "SAVE",
      reasonCode: "this_chat_only",
      statement: "Use concise answers here.",
      thisChatOnly: true
    })));
    expect(result).toEqual({
      operation: "SAVE",
      statement: "Use concise answers here.",
      status: "THIS_CHAT_ONLY"
    });
    expect(deps.explicitService.create).not.toHaveBeenCalled();
  });

  it("rejects secret-shaped intent without copying its statement into the artifact", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "SAVE",
      reasonCode: "secret_content",
      sensitivity: "SECRET",
      statement: "private-secret-sentinel"
    })));
    expect(result).toEqual({ operation: "SAVE", status: "REJECTED" });
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
    expect(deps.explicitService.create).not.toHaveBeenCalled();
  });

  it("returns 2–5 opaque candidates instead of guessing a destructive target", async () => {
    const first = memorySummaryFixture();
    const second = memorySummaryFixture({
      currentVersionId: "memory-version-2",
      id: "memory-fact-2"
    });
    const deps = dependencies();
    deps.targetSearch.semantic.mockResolvedValue({
      status: "READY",
      targets: [actionTarget(first), actionTarget(second)]
    });
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      targetQuery: "concise answers"
    })));
    expect(result).toMatchObject({ operation: "FORGET", status: "AMBIGUOUS" });
    expect(result?.candidates).toHaveLength(2);
    expect(result?.candidates?.[0]).not.toHaveProperty("factId");
    expect(deps.targetSelector.select).toHaveBeenCalledOnce();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("commits a unique semantic paraphrase target", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      targetQuery: "the preference about brief replies"
    })));
    expect(result).toEqual({ operation: "FORGET", status: "COMMITTED" });
    expect(deps.targetSearch.exact).toHaveBeenCalledOnce();
    expect(deps.targetSearch.semantic).toHaveBeenCalledOnce();
    expect(deps.lifecycleService.forget).toHaveBeenCalledOnce();
  });

  it("does not guess from natural text when a supplied opaque ref is invalid", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      referencedMemoryRef: "invalid-opaque-ref",
      targetQuery: "concise answers"
    })));
    expect(result).toEqual({ operation: "FORGET", status: "REJECTED" });
    expect(deps.targetSearch.exact).not.toHaveBeenCalled();
    expect(deps.targetSearch.semantic).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("rejects an old opaque ref when its authoritative target is legacy-scoped", async () => {
    const key = randomBytes(32);
    const refs = createMemoryClientRefService({ encryptionKey: () => key });
    const memoryRef = refs.mint("user-1", {
      allowedOperations: ["FORGET"],
      originatingRunId: "older-run",
      target: {
        exactItemId: "memory-version-1",
        factId: "memory-fact-1",
        factVersionId: "memory-version-1",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    const deps = dependencies({
      get: vi.fn(async () => memoryDetailFixture(memorySummaryFixture({
        scope: { targetId: "folder-1", type: "FOLDER" }
      })))
    });

    await expect(createMemoryIntentActionExecutor({
      ...deps,
      clientRefs: refs
    } as never).execute(execution(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      referencedMemoryRef: memoryRef
    })))).resolves.toEqual({ operation: "FORGET", status: "REJECTED" });

    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("uses an exact active statement before semantic candidates", async () => {
    const deps = dependencies();
    deps.targetSearch.exact.mockResolvedValue({
      status: "READY",
      targets: [actionTarget(memorySummaryFixture())]
    } as never);
    await createMemoryIntentActionExecutor({ ...deps, clientRefs } as never).execute(
      execution(intent({
        action: "FORGET",
        reasonCode: "forget_request",
        targetQuery: "I prefer concise answers in Russian."
      }))
    );
    expect(deps.targetSearch.exact).toHaveBeenCalledOnce();
    expect(deps.targetSearch.semantic).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).toHaveBeenCalledOnce();
  });

  it("uses one HIGH-confidence selector result and never guesses another target", async () => {
    const first = actionTarget(memorySummaryFixture());
    const second = actionTarget(memorySummaryFixture({
      currentVersionId: "memory-version-2",
      id: "memory-fact-2"
    }));
    const deps = dependencies();
    deps.targetSearch.semantic.mockResolvedValue({ status: "READY", targets: [first, second] });
    deps.targetSelector.select.mockResolvedValue({
      acceptedOutputHash: "b".repeat(64),
      bindingId: "binding-selector",
      candidateMapHash: "c".repeat(64),
      selectedHandle: "c1",
      status: "READY"
    } as never);
    await createMemoryIntentActionExecutor({ ...deps, clientRefs } as never).execute(
      execution(intent({
        action: "FORGET",
        reasonCode: "forget_request",
        targetQuery: "the second preference"
      }))
    );
    expect(deps.targetSelector.select).toHaveBeenCalledOnce();
    expect(deps.targetSelector.select).toHaveBeenCalledWith(expect.objectContaining({
      controlBindingId: "binding-1"
    }));
    expect(deps.targetSelector.assertAuthorized).toHaveBeenCalledWith({
      acceptedOutputHash: "b".repeat(64),
      bindingId: "binding-selector",
      controlBindingId: "binding-1",
      userId: "user-1"
    });
    expect(deps.authorizationRepository.mintForControl).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        bindingId: "binding-1",
        controlIntent: expect.objectContaining({ action: "FORGET" }),
        targetSelectionBindingId: "binding-selector",
        targetSelectionCandidateMapHash: "c".repeat(64),
        targetSelectionOutputHash: "b".repeat(64),
        targetSelectionSelectedHandle: "c1"
      }),
      now
    );
    expect(deps.lifecycleService.forget).toHaveBeenCalledWith(
      "user-1",
      "memory-fact-2",
      expect.objectContaining({ expectedVersionId: "memory-version-2" }),
      expect.anything()
    );
  });

  it("fails closed before destructive mutation when linked selector authority drifts", async () => {
    const first = actionTarget(memorySummaryFixture());
    const second = actionTarget(memorySummaryFixture({
      currentVersionId: "memory-version-2",
      id: "memory-fact-2"
    }));
    const deps = dependencies();
    deps.targetSearch.semantic.mockResolvedValue({ status: "READY", targets: [first, second] });
    deps.targetSelector.select.mockResolvedValue({
      acceptedOutputHash: "b".repeat(64),
      bindingId: "binding-selector",
      candidateMapHash: "c".repeat(64),
      selectedHandle: "c1",
      status: "READY"
    } as never);
    deps.targetSelector.assertAuthorized.mockRejectedValueOnce(new Error("policy drift"));

    await expect(createMemoryIntentActionExecutor({ ...deps, clientRefs } as never).execute(
      execution(intent({
        action: "FORGET",
        reasonCode: "forget_request",
        targetQuery: "the second preference"
      }))
    )).resolves.toEqual({ operation: "FORGET", status: "REJECTED" });

    expect(deps.targetSelector.assertAuthorized).toHaveBeenCalledOnce();
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("fails closed before a direct mutation when original control authority drifts", async () => {
    const deps = dependencies();
    deps.targetSelector.assertControlAuthorized.mockRejectedValueOnce(new Error("policy drift"));

    await expect(createMemoryIntentActionExecutor({ ...deps, clientRefs } as never).execute(
      execution(intent({
        action: "FORGET",
        reasonCode: "forget_request",
        targetQuery: "the preference about brief replies"
      }))
    )).resolves.toEqual({ operation: "FORGET", status: "REJECTED" });

    expect(deps.targetSelector.assertControlAuthorized).toHaveBeenCalledOnce();
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("fails closed when semantic target lookup is unavailable", async () => {
    const deps = dependencies();
    deps.targetSearch.semantic.mockResolvedValue({
      reason: "memory_vector_unavailable",
      status: "UNAVAILABLE"
    } as never);
    await expect(createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "FORGET",
      reasonCode: "forget_request",
      targetQuery: "a paraphrased target"
    })))).resolves.toBeNull();
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
    expect(deps.lifecycleService.forget).not.toHaveBeenCalled();
  });

  it("routes explicit Saved Memories SEARCH through bounded semantic lookup", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "SEARCH",
      reasonCode: "search_request",
      targetQuery: "saved preference about concise replies"
    })));
    expect(result).toMatchObject({ operation: "SEARCH", status: "COMPLETE" });
    expect(result?.items).toHaveLength(1);
    expect(deps.targetSearch.semantic).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "attempt-1",
      query: "saved preference about concise replies",
      userId: "user-1"
    }));
    expect(deps.explicitService.search).not.toHaveBeenCalled();
  });

  it("rejects a secret replacement before target selection and never echoes it", async () => {
    const deps = dependencies();
    const result = await createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({
      action: "UPDATE",
      reasonCode: "secret_content",
      replacementStatement: "sk-abcdefghijklmnopqrstuvwxyz123456",
      targetQuery: "concise answers"
    })));
    expect(result).toEqual({ operation: "UPDATE", status: "REJECTED" });
    expect(JSON.stringify(result)).not.toContain("sk-");
    expect(deps.targetSearch.exact).not.toHaveBeenCalled();
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
  });

  it("turns reset intent into confirmation without a mutation", async () => {
    const deps = dependencies();
    await expect(createMemoryIntentActionExecutor({
      ...deps,
      clientRefs
    } as never).execute(execution(intent({ action: "RESET", reasonCode: "reset_request" }))))
      .resolves.toEqual({ operation: "RESET", status: "CONFIRMATION_REQUIRED" });
    expect(deps.authorizationRepository.mintForControl).not.toHaveBeenCalled();
  });
});
