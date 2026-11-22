import type { PrismaClient } from "@prisma/client";
import {
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS,
  MAX_EMBEDDING_INPUT_CHARS,
  type EmbeddingAdapter,
  type EmbeddingUsage
} from "../providers/embeddings";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { createPrismaEmbeddingRuntime, type EmbeddingRuntimeStore } from "../providerRuntime/embeddingRuntime";
import {
  ChatSearchEmbeddingError,
  type ChatSearchEmbedder,
  type ChatSearchEmbedRequest,
  type ChatSearchEmbeddingModel
} from "./embedder";
import { recordChatSearchUsage, type ChatSearchUsageDb, type ChatSearchUsageRecord } from "./usage";

/**
 * The Prisma-backed `ChatSearchEmbedder`: the installation's past-chat embedding role
 * (`SystemModelPolicy.embeddingProviderModelId`) resolved on its installation credential, read again on every call,
 * so a role change applies to the next call and a call for another model is refused (no silent substitution,
 * `agent_docs/PROVIDERS.md`). "Not set" and "set but unusable" stay distinct, and neither ever falls back to another
 * model. Every call that reported usage, a rejected response included, is recorded after it through
 * `recordChatSearchUsage`, without delaying or failing the result.
 */

const POLICY_ID = "installation";
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type ChatSearchEmbeddingBinding = Readonly<{
  adapter: EmbeddingAdapter;
  executionSnapshot: Readonly<{ model: Readonly<{ upstreamModelId: string }>; providerFamily: string }>;
  providerModelId: string;
}>;

export type ChatSearchEmbeddingRuntime = Readonly<{
  resolveForInstallation(input: Readonly<{ providerModelId: string }>): Promise<ChatSearchEmbeddingBinding>;
}>;

export type ChatSearchEmbedderDb = Pick<PrismaClient, "systemModelPolicy"> & ChatSearchUsageDb & EmbeddingRuntimeStore;

export type ChatSearchEmbedderOptions = Readonly<{
  /** Resolves the role's binding; the installation embedding runtime by default. */
  runtime?: ChatSearchEmbeddingRuntime;
  /** Records a call's reported usage; `recordChatSearchUsage` on `db` by default. Never awaited by the result. */
  recordUsage?: (record: ChatSearchUsageRecord) => Promise<unknown>;
}>;

function contentFreeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : fallback;
}

function resolutionCode(error: unknown): string {
  return error instanceof ProviderAdmissionError ? contentFreeCode(error.code, "embedding_unavailable") : "embedding_unavailable";
}

function validRequest(request: ChatSearchEmbedRequest): boolean {
  return (request.mode === "document" || request.mode === "query") &&
    (request.latencyClass === "background" || request.latencyClass === "interactive") &&
    typeof request.userId === "string" && request.userId.length > 0 &&
    Array.isArray(request.texts) && request.texts.length > 0 && request.texts.length <= MAX_EMBEDDING_BATCH_INPUTS &&
    request.texts.every((text) => typeof text === "string" && text.trim().length > 0 && text.length <= MAX_EMBEDDING_INPUT_CHARS);
}

/** One finite vector per text, all of one positive dimension; anything else rejects the whole batch. */
function acceptedVectors(vectors: unknown, count: number): Readonly<{ vectors: readonly (readonly number[])[]; dimension: number }> {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new ChatSearchEmbeddingError("embedding_response_count_mismatch");
  const dimension = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (dimension <= 0) throw new ChatSearchEmbeddingError("embedding_response_vector_invalid");
  for (const vector of vectors) {
    if (!Array.isArray(vector)) throw new ChatSearchEmbeddingError("embedding_response_vector_invalid");
    if (vector.length !== dimension) throw new ChatSearchEmbeddingError("embedding_response_dimension_mismatch");
    if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ChatSearchEmbeddingError("embedding_response_vector_invalid");
    }
  }
  return { dimension, vectors: vectors as readonly (readonly number[])[] };
}

export function createChatSearchEmbedder(db: ChatSearchEmbedderDb, options: ChatSearchEmbedderOptions = {}): ChatSearchEmbedder {
  const runtime = options.runtime ?? createPrismaEmbeddingRuntime(db);
  const recordUsage = options.recordUsage ?? ((record: ChatSearchUsageRecord) => recordChatSearchUsage(db, record));

  const assignedModel = async (): Promise<string | null> => {
    const policy = await db.systemModelPolicy.findUnique({ select: { embeddingProviderModelId: true }, where: { id: POLICY_ID } });
    return policy?.embeddingProviderModelId ?? null;
  };

  const record = (
    request: ChatSearchEmbedRequest,
    binding: ChatSearchEmbeddingBinding,
    usage: EmbeddingUsage | null,
    requestCount: number | null | undefined
  ): void => {
    if (!usage) return;
    const entry: ChatSearchUsageRecord = {
      costUsd: usage.costUsd ?? null,
      modelId: binding.executionSnapshot.model.upstreamModelId,
      provider: binding.executionSnapshot.providerFamily,
      providerModelId: binding.providerModelId,
      purpose: request.mode === "document" ? "memory_indexing" : "memory_retrieval",
      requestCount: requestCount ?? null,
      usage: { inputTokens: usage.inputTokens, totalTokens: usage.totalTokens },
      userId: request.userId
    };
    // Bookkeeping after the call: started, never awaited, and its failure never reaches the caller.
    void Promise.resolve().then(() => recordUsage(entry)).catch(() => undefined);
  };

  return {
    async currentModel(): Promise<ChatSearchEmbeddingModel> {
      const providerModelId = await assignedModel();
      if (providerModelId === null) return { kind: "unset" };
      try {
        await runtime.resolveForInstallation({ providerModelId });
        return { kind: "model", providerModelId };
      } catch (error) {
        return { code: resolutionCode(error), kind: "unavailable", providerModelId };
      }
    },

    async embed(request: ChatSearchEmbedRequest) {
      if (!validRequest(request)) throw new ChatSearchEmbeddingError("embedding_batch_invalid");
      if (request.signal?.aborted) throw new ChatSearchEmbeddingError("embedding_request_cancelled");
      if (await assignedModel() !== request.providerModelId) throw new ChatSearchEmbeddingError("embedding_model_changed");
      let binding: ChatSearchEmbeddingBinding;
      try {
        binding = await runtime.resolveForInstallation({ providerModelId: request.providerModelId });
      } catch (error) {
        throw new ChatSearchEmbeddingError(resolutionCode(error));
      }
      if (binding.providerModelId !== request.providerModelId) throw new ChatSearchEmbeddingError("embedding_model_changed");
      let result: Awaited<ReturnType<EmbeddingAdapter["embed"]>>;
      try {
        result = await binding.adapter.embed({
          latencyClass: request.latencyClass, mode: request.mode, signal: request.signal, texts: request.texts
        });
      } catch (error) {
        if (error instanceof EmbeddingAdapterError) {
          record(request, binding, error.usage, error.providerRequestCount);
          throw new ChatSearchEmbeddingError(contentFreeCode(error.code, "embedding_provider_request_failed"), error.retryAfterMs);
        }
        if (request.signal?.aborted) throw new ChatSearchEmbeddingError("embedding_request_cancelled");
        throw new ChatSearchEmbeddingError("embedding_provider_request_failed");
      }
      // A response is paid for whether or not its vectors are accepted.
      record(request, binding, result.usage, result.providerRequestCount);
      return acceptedVectors(result.vectors, request.texts.length);
    }
  };
}
