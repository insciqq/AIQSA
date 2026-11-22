import type { PrismaClient } from "@prisma/client";
import {
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS,
  MAX_EMBEDDING_INPUT_CHARS,
  type EmbeddingAdapter,
  type EmbeddingUsage
} from "../providers/embeddings";
import type { EmbeddingProviderAdmissionRole } from "../providerRuntime/admission";
import {
  createEmbeddingModelRoleResolver,
  type EmbeddingModelRolePrisma,
  type EmbeddingModelRoleResolver
} from "../providerRuntime/embeddingModelRole";
import { createPrismaEmbeddingRuntime, type EmbeddingRuntimeStore } from "../providerRuntime/embeddingRuntime";
import {
  ChatSearchEmbeddingError,
  type ChatSearchEmbedder,
  type ChatSearchEmbedRequest,
  type ChatSearchEmbeddingModel
} from "./embedder";
import { recordChatSearchUsage, type ChatSearchUsageDb, type ChatSearchUsageRecord } from "./usage";

/**
 * The Prisma-backed `ChatSearchEmbedder`: the installation's past-chat embedding role, resolved by
 * `createEmbeddingModelRoleResolver` on its installation credential and read again on every call, so a role change
 * applies to the next call and a call for another model is refused (no silent substitution,
 * `agent_docs/PROVIDERS.md`). "Not set" and "set but unusable" (a model that lost its embedding evidence or its
 * credential) stay distinct, the latter with its code, and neither ever falls back to another model. Every call that
 * reported usage, a rejected response included, is recorded after it through `recordChatSearchUsage`, without
 * delaying or failing the result.
 */

const UNAVAILABLE = "embedding_unavailable";
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type ChatSearchEmbeddingBinding = Readonly<{
  adapter: EmbeddingAdapter;
  executionSnapshot: Readonly<{ model: Readonly<{ upstreamModelId: string }>; providerFamily: string }>;
  providerModelId: string;
}>;

export type ChatSearchEmbeddingRuntime = Readonly<{
  /** Binds the role the resolver admitted to an adapter, without admitting it again. */
  bindAdmitted(role: EmbeddingProviderAdmissionRole): Promise<ChatSearchEmbeddingBinding>;
}>;

export type ChatSearchEmbedderDb = Pick<PrismaClient, "systemModelPolicy"> & ChatSearchUsageDb & EmbeddingRuntimeStore &
  EmbeddingModelRolePrisma;

export type ChatSearchEmbedderOptions = Readonly<{
  /** Resolves the past-chat embedding role; `createEmbeddingModelRoleResolver(db)` by default. */
  role?: Pick<EmbeddingModelRoleResolver, "resolve">;
  /** Binds the admitted role; the installation embedding runtime by default. */
  runtime?: ChatSearchEmbeddingRuntime;
  /** Records a call's reported usage; `recordChatSearchUsage` on `db` by default. Never awaited by the result. */
  recordUsage?: (record: ChatSearchUsageRecord) => Promise<unknown>;
}>;

function contentFreeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : fallback;
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
  const role = options.role ?? createEmbeddingModelRoleResolver(db);
  const recordUsage = options.recordUsage ?? ((record: ChatSearchUsageRecord) => recordChatSearchUsage(db, record));

  /** The role now; a failure to read it (the database, not the model) is a content-free `embedding_unavailable`. */
  const resolveRole = async () => {
    try {
      return await role.resolve();
    } catch {
      throw new ChatSearchEmbeddingError(UNAVAILABLE);
    }
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
      const resolution = await resolveRole();
      if (resolution.kind === "unset") return { kind: "unset" };
      if (resolution.kind === "unavailable") {
        return { code: contentFreeCode(resolution.code, UNAVAILABLE), kind: "unavailable", providerModelId: resolution.providerModelId };
      }
      return { kind: "model", providerModelId: resolution.providerModelId };
    },

    async embed(request: ChatSearchEmbedRequest) {
      if (!validRequest(request)) throw new ChatSearchEmbeddingError("embedding_batch_invalid");
      if (request.signal?.aborted) throw new ChatSearchEmbeddingError("embedding_request_cancelled");
      const resolution = await resolveRole();
      if (resolution.kind === "unset" || resolution.providerModelId !== request.providerModelId) {
        throw new ChatSearchEmbeddingError("embedding_model_changed");
      }
      if (resolution.kind === "unavailable") throw new ChatSearchEmbeddingError(contentFreeCode(resolution.code, UNAVAILABLE));
      let binding: ChatSearchEmbeddingBinding;
      try {
        binding = await runtime.bindAdmitted(resolution.role);
      } catch {
        throw new ChatSearchEmbeddingError(UNAVAILABLE);
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
