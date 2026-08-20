import { randomUUID } from "node:crypto";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { normalizeTokenUsage, type TokenUsage } from "../../domain/usage";
import { memorySha256 } from "../memory/persistence/lexical";
import type {
  KnowledgeEvidenceDispatchManifestDraft
} from "./evidenceDispatchManifest";
import type {
  KnowledgeProviderAttemptRecovery,
  KnowledgeProviderAttemptPurpose,
  KnowledgeProviderAttemptUsage,
  StoredKnowledgeEvidenceDispatch,
  createPrismaKnowledgeEvidenceDispatchRepository
} from "./evidenceDispatchRepository";

export type KnowledgeEvidenceDispatchStore = Pick<
  ReturnType<typeof createPrismaKnowledgeEvidenceDispatchRepository>,
  | "dispatch"
  | "loadForRecovery"
  | "markAmbiguous"
  | "recover"
  | "release"
  | "reserve"
  | "settle"
>;

export type PreparedKnowledgeProviderDispatch = Readonly<{
  dispatch: StoredKnowledgeEvidenceDispatch;
  identity: Readonly<{
    attemptId: string;
    checkpointHash: string;
    idempotencyKey: string;
    manifestHash: string;
    modelRunId: string;
    providerBindingKey: string;
    requestHash: string;
  }>;
  leaseToken: string;
}>;

export type KnowledgeProviderDispatchRecovery =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "ambiguous" | "busy" | "released" | "request_required";
    }>
  | Readonly<{
      kind: "dispatch" | "resume";
      prepared: PreparedKnowledgeProviderDispatch;
      providerResponseId: string | null;
    }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "settled";
      providerResponseId: string | null;
    }>;

const PROVIDER_DISPATCH_LEASE_MS = 15 * 60 * 1_000;

function attemptUsage(
  usage: TokenUsage & Readonly<{ estimatedCostMicros?: number | null }>
): KnowledgeProviderAttemptUsage {
  const normalized = normalizeTokenUsage(usage);
  return Object.freeze({
    cachedInputTokens: normalized.cachedInputTokens,
    cacheWriteInputTokens: normalized.cacheWriteInputTokens,
    estimatedCostMicros: usage.estimatedCostMicros ?? null,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    totalTokens: normalized.totalTokens
  });
}

function estimatedUsage(requestPreview: unknown): KnowledgeProviderAttemptUsage {
  const inputTokens = estimateApproxTokens(requestPreview);
  return Object.freeze({
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostMicros: null,
    inputTokens,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: inputTokens
  });
}

function preparedDispatch(
  dispatch: StoredKnowledgeEvidenceDispatch,
  leaseToken: string
): PreparedKnowledgeProviderDispatch {
  const attempt = dispatch.attempt;
  return Object.freeze({
    dispatch,
    identity: Object.freeze({
      attemptId: attempt.id,
      checkpointHash: attempt.checkpointHash,
      idempotencyKey: attempt.idempotencyKey,
      manifestHash: dispatch.draft.manifestHash,
      modelRunId: attempt.modelRunId,
      providerBindingKey: attempt.providerBindingKey,
      requestHash: attempt.requestHash
    }),
    leaseToken
  });
}

function recoveredDispatch(
  recovery: KnowledgeProviderAttemptRecovery
): KnowledgeProviderDispatchRecovery {
  if (recovery.kind === "dispatch" || recovery.kind === "resume") {
    return Object.freeze({
      kind: recovery.kind,
      prepared: preparedDispatch(recovery.dispatch, recovery.leaseToken),
      providerResponseId: recovery.kind === "resume"
        ? recovery.providerResponseId
        : null
    });
  }
  return recovery;
}

export function createKnowledgeProviderDispatchLifecycle(
  store: KnowledgeEvidenceDispatchStore,
  options: Readonly<{
    now?: () => Date;
    uuid?: () => string;
  }> = {}
) {
  const currentTime = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;

  return Object.freeze({
    async prepare(input: Readonly<{
      draft: KnowledgeEvidenceDispatchManifestDraft;
      modelRunId: string;
      ordinal: number;
      providerBindingKey?: string;
      purpose: KnowledgeProviderAttemptPurpose;
      requestPreview: unknown;
      roundIndex: number;
    }>): Promise<PreparedKnowledgeProviderDispatch> {
      const providerBindingKey = input.providerBindingKey ?? "answer";
      const requestHash = memorySha256(input.requestPreview);
      const checkpointHash = memorySha256({
        manifestHash: input.draft.manifestHash,
        modelRunId: input.modelRunId,
        ordinal: input.ordinal,
        providerBindingKey,
        purpose: input.purpose,
        requestHash,
        roundIndex: input.roundIndex,
        version: 1
      });
      const idempotencyKey = `knowledge-answer:${input.ordinal}:${checkpointHash}`;
      const leaseToken = uuid();
      const now = currentTime();
      const reserved = await store.reserve({
        checkpointHash,
        draft: input.draft,
        estimatedUsage: estimatedUsage(input.requestPreview),
        idempotencyKey,
        leaseExpiresAt: new Date(now.valueOf() + PROVIDER_DISPATCH_LEASE_MS),
        leaseToken,
        modelRunId: input.modelRunId,
        now,
        ordinal: input.ordinal,
        providerBindingKey,
        purpose: input.purpose,
        requestHash,
        roundIndex: input.roundIndex
      });
      const attempt = reserved.dispatch.attempt;
      if (!attempt.leaseToken) {
        throw new Error("knowledge_provider_attempt_not_dispatchable");
      }
      return preparedDispatch(reserved.dispatch, attempt.leaseToken);
    },

    async inspect(input: Readonly<{
      modelRunId: string;
      ordinal: number;
    }>): Promise<StoredKnowledgeEvidenceDispatch | null> {
      return store.loadForRecovery(input);
    },

    async recover(input: Readonly<{
      modelRunId: string;
      ordinal: number;
      providerResponseId?: string | null;
      requestPreview?: unknown;
    }>): Promise<KnowledgeProviderDispatchRecovery> {
      const now = currentTime();
      return recoveredDispatch(await store.recover({
        leaseExpiresAt: new Date(now.valueOf() + PROVIDER_DISPATCH_LEASE_MS),
        leaseToken: uuid(),
        modelRunId: input.modelRunId,
        now,
        ordinal: input.ordinal,
        providerResponseId: input.providerResponseId ?? null,
        ...(input.requestPreview === undefined
          ? {}
          : { requestHash: memorySha256(input.requestPreview) })
      }));
    },

    async dispatch(prepared: PreparedKnowledgeProviderDispatch): Promise<void> {
      const dispatchedAt = currentTime();
      const transition = await store.dispatch({
        ...prepared.identity,
        dispatchedAt,
        leaseExpiresAt: new Date(dispatchedAt.valueOf() + PROVIDER_DISPATCH_LEASE_MS),
        leaseToken: prepared.leaseToken
      });
      // Only the worker that durably moves RESERVED -> DISPATCHED may perform
      // provider I/O. An idempotent result means another worker already crossed
      // the irreversible boundary, so replay must fail closed instead of
      // dispatching the same private request again.
      if (transition.kind !== "transitioned") {
        throw new Error("knowledge_provider_attempt_already_dispatched");
      }
    },

    async settle(
      prepared: PreparedKnowledgeProviderDispatch,
      input: Readonly<{
        providerResponseId?: string | null;
        usage: TokenUsage & Readonly<{ estimatedCostMicros?: number | null }>;
      }>
    ): Promise<void> {
      await store.settle({
        ...prepared.identity,
        actualUsage: attemptUsage(input.usage),
        leaseToken: prepared.leaseToken,
        providerResponseId: input.providerResponseId ?? null,
        settledAt: currentTime()
      });
    },

    async release(
      prepared: PreparedKnowledgeProviderDispatch,
      reason = "provider_dispatch_not_started"
    ): Promise<void> {
      await store.release({
        ...prepared.identity,
        leaseToken: prepared.leaseToken,
        reason,
        releasedAt: currentTime()
      });
    },

    async markAmbiguous(
      prepared: PreparedKnowledgeProviderDispatch,
      input: Readonly<{
        providerResponseId?: string | null;
        reason?: string;
      }> = {}
    ): Promise<void> {
      await store.markAmbiguous({
        ...prepared.identity,
        ambiguousAt: currentTime(),
        leaseToken: prepared.leaseToken,
        providerResponseId: input.providerResponseId ?? null,
        reason: input.reason ?? "provider_dispatch_failed"
      });
    }
  });
}

export type KnowledgeProviderDispatchLifecycle = ReturnType<
  typeof createKnowledgeProviderDispatchLifecycle
>;
