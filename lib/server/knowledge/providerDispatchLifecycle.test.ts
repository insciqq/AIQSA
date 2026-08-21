import { describe, expect, it, vi } from "vitest";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import {
  createKnowledgeProviderDispatchLifecycle,
  type KnowledgeEvidenceDispatchStore
} from "./providerDispatchLifecycle";

function draft() {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "call-1:result:1",
      exactExcerpt: "Alpha equals 41.2.",
      fileName: "alpha.md",
      handle: "K1",
      locator: "page=1; heading=Summary",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Alpha",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage verified: no.",
    footer: "</private_knowledge_evidence>",
    header: "<private_knowledge_evidence version=\"2\">",
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    runtimeVersion: 2,
    profileId: "fake:model",
    promptFragmentVersion: 2
  });
}

function store() {
  const reserve = vi.fn<KnowledgeEvidenceDispatchStore["reserve"]>(async (input) => ({
    dispatch: {
      attempt: {
        actualUsage: null,
        ambiguousAt: null,
        checkpointHash: input.checkpointHash,
        dispatchedAt: null,
        estimatedUsage: input.estimatedUsage,
        failureCode: null,
        id: "attempt-1",
        idempotencyKey: input.idempotencyKey,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseToken: input.leaseToken,
        modelRunId: input.modelRunId,
        ordinal: input.ordinal,
        providerBindingKey: input.providerBindingKey,
        providerResponseId: null,
        purpose: input.purpose,
        releasedAt: null,
        requestHash: input.requestHash,
        roundIndex: input.roundIndex,
        settledAt: null,
        state: "reserved"
      },
      draft: input.draft,
      exclusions: [],
      items: [],
      manifestId: "manifest-1",
      profileRevisionIds: [],
      retrievalSessionId: "session-1"
    },
    kind: "created"
  }));
  const transition = async () => ({
    attempt: (await reserve.mock.results[0]!.value).dispatch.attempt,
    kind: "transitioned" as const
  });
  const loadForRecovery = vi.fn<KnowledgeEvidenceDispatchStore["loadForRecovery"]>(
    async () => (await reserve.mock.results[0]!.value).dispatch
  );
  const recover = vi.fn<KnowledgeEvidenceDispatchStore["recover"]>(async (input) => {
    const dispatch = (await reserve.mock.results[0]!.value).dispatch;
    return {
      dispatch: {
        ...dispatch,
        attempt: {
          ...dispatch.attempt,
          leaseExpiresAt: input.leaseExpiresAt,
          leaseToken: input.leaseToken
        }
      },
      kind: "dispatch",
      leaseToken: input.leaseToken
    };
  });
  return {
    dispatch: vi.fn<KnowledgeEvidenceDispatchStore["dispatch"]>(transition),
    loadForRecovery,
    markAmbiguous: vi.fn<KnowledgeEvidenceDispatchStore["markAmbiguous"]>(transition),
    recover,
    release: vi.fn<KnowledgeEvidenceDispatchStore["release"]>(transition),
    reserve,
    settle: vi.fn<KnowledgeEvidenceDispatchStore["settle"]>(transition)
  } satisfies KnowledgeEvidenceDispatchStore;
}

describe("Knowledge provider dispatch lifecycle", () => {
  it("seals the exact manifest before dispatch and settles actual provider usage", async () => {
    const persistence = store();
    const lifecycle = createKnowledgeProviderDispatchLifecycle(persistence, {
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      uuid: () => "lease-token-00000001"
    });
    const manifest = draft();
    const prepared = await lifecycle.prepare({
      draft: manifest,
      modelRunId: "run-1",
      ordinal: 1,
      purpose: "answer",
      requestPreview: { input: "private request" },
      roundIndex: 0
    });

    expect(persistence.reserve).toHaveBeenCalledOnce();
    expect(persistence.dispatch).not.toHaveBeenCalled();
    expect(prepared.dispatch.draft.message).toBe(manifest.message);
    expect(prepared.dispatch.draft.messageHash).toBe(manifest.messageHash);

    await lifecycle.dispatch(prepared);
    await lifecycle.settle(prepared, {
      providerResponseId: "response-1",
      usage: {
        cachedInputTokens: 2,
        inputTokens: 12,
        outputTokens: 4,
        reasoningTokens: 1,
        totalTokens: 16
      }
    });

    expect(persistence.dispatch).toHaveBeenCalledOnce();
    expect(persistence.settle).toHaveBeenCalledWith(expect.objectContaining({
      actualUsage: {
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        estimatedCostMicros: null,
        inputTokens: 12,
        outputTokens: 4,
        reasoningTokens: 1,
        totalTokens: 16
      },
      providerResponseId: "response-1"
    }));
  });

  it("keeps pre-dispatch release and post-dispatch ambiguity distinct", async () => {
    const persistence = store();
    const lifecycle = createKnowledgeProviderDispatchLifecycle(persistence, {
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      uuid: () => "lease-token-00000001"
    });
    const prepared = await lifecycle.prepare({
      draft: draft(),
      modelRunId: "run-1",
      ordinal: 1,
      purpose: "answer",
      requestPreview: { input: "private request" },
      roundIndex: 0
    });

    await lifecycle.release(prepared);
    await lifecycle.markAmbiguous(prepared);

    expect(persistence.release).toHaveBeenCalledOnce();
    expect(persistence.markAmbiguous).toHaveBeenCalledOnce();
  });

  it("lets only the duplicate worker that wins the dispatch CAS enter provider I/O", async () => {
    const persistence = store();
    const lifecycle = createKnowledgeProviderDispatchLifecycle(persistence, {
      now: () => new Date("2026-08-19T20:00:00.000Z"),
      uuid: () => "lease-token-00000001"
    });
    const prepared = await lifecycle.prepare({
      draft: draft(),
      modelRunId: "run-1",
      ordinal: 1,
      purpose: "answer",
      requestPreview: { input: "private request" },
      roundIndex: 0
    });
    let transitioned = false;
    persistence.dispatch.mockImplementation(async () => {
      if (!transitioned) {
        transitioned = true;
        return { attempt: prepared.dispatch.attempt, kind: "transitioned" };
      }
      return { attempt: prepared.dispatch.attempt, kind: "idempotent" };
    });
    const providerStream = vi.fn(async () => undefined);
    const worker = async () => {
      try {
        await lifecycle.dispatch(prepared);
        await providerStream();
        return "dispatched" as const;
      } catch (error) {
        expect(error).toMatchObject({
          message: "knowledge_provider_attempt_already_dispatched"
        });
        return "fenced" as const;
      }
    };

    await expect(Promise.all([worker(), worker()])).resolves.toEqual([
      "dispatched",
      "fenced"
    ]);
    expect(persistence.dispatch).toHaveBeenCalledTimes(2);
    expect(providerStream).toHaveBeenCalledOnce();
  });

  it("replays the persisted manifest and fences a recovered reserved attempt", async () => {
    const persistence = store();
    const lifecycle = createKnowledgeProviderDispatchLifecycle(persistence, {
      now: () => new Date("2026-08-19T20:20:00.000Z"),
      uuid: () => "lease-token-recovery-01"
    });
    const manifest = draft();
    await lifecycle.prepare({
      draft: manifest,
      modelRunId: "run-1",
      ordinal: 1,
      purpose: "answer",
      requestPreview: { input: "private request" },
      roundIndex: 0
    });

    const inspected = await lifecycle.inspect({ modelRunId: "run-1", ordinal: 1 });
    const recovered = await lifecycle.recover({
      modelRunId: "run-1",
      ordinal: 1,
      requestPreview: { input: "private request" }
    });

    expect(inspected?.draft.message).toBe(manifest.message);
    expect(recovered).toMatchObject({
      kind: "dispatch",
      prepared: {
        dispatch: { draft: { message: manifest.message } },
        leaseToken: "lease-token-recovery-01"
      },
      providerResponseId: null
    });
    expect(persistence.recover).toHaveBeenCalledWith(expect.objectContaining({
      leaseToken: "lease-token-recovery-01",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    }));
  });
});
