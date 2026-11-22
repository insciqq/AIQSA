import { describe, expect, it, vi } from "vitest";
import { EmbeddingAdapterError, type EmbeddingAdapter } from "../providers/embeddings";
import { ProviderConfigurationError } from "../providers/providerConfiguration";
import { ProviderAdmissionError, type EmbeddingProviderAdmissionRole } from "../providerRuntime/admission";
import { createEmbeddingModelRoleResolver, type EmbeddingRoleLoader } from "../providerRuntime/embeddingModelRole";
import { ChatSearchEmbeddingError, type ChatSearchEmbedRequest } from "./embedder";
import { createChatSearchEmbedder, type ChatSearchEmbedderDb } from "./embedderPrisma";
import type { ChatSearchUsageRecord } from "./usage";

vi.mock("../observability", () => ({ logEvent: vi.fn() }));

const request = (overrides: Partial<ChatSearchEmbedRequest> = {}): ChatSearchEmbedRequest => ({
  latencyClass: "background", mode: "document", providerModelId: "embed-a", texts: ["first", "second"], userId: "owner-1",
  ...overrides
});

function setup(options: Readonly<{
  assigned?: string | null;
  embed?: EmbeddingAdapter["embed"];
  /** The installation admission of the assigned model. */
  admit?: EmbeddingRoleLoader;
}> = {}) {
  const policy = { embeddingProviderModelId: options.assigned === undefined ? "embed-a" : options.assigned, version: 4 };
  const embed = vi.fn(options.embed ?? (async (input: Parameters<EmbeddingAdapter["embed"]>[0]) => ({
    model: "upstream-embed", providerRequestCount: 1, requestId: null,
    usage: { costUsd: 0.000002, inputTokens: 12, totalTokens: 12 },
    vectors: input.texts.map((_, index) => [index, 0.5, -1])
  })));
  const admit = vi.fn(options.admit ?? (async (_db: unknown, { providerModelId }: { providerModelId: string }) =>
    ({ authority: { providerModelId } }) as unknown as EmbeddingProviderAdmissionRole));
  const bindAdmitted = vi.fn(async (role: EmbeddingProviderAdmissionRole) => ({
    adapter: { embed }, executionSnapshot: { model: { upstreamModelId: "upstream-embed" }, providerFamily: "openrouter" },
    providerModelId: (role as unknown as { authority: { providerModelId: string } }).authority.providerModelId
  }));
  const recorded: ChatSearchUsageRecord[] = [];
  const db = { systemModelPolicy: { findUnique: vi.fn(async () => policy) } } as unknown as ChatSearchEmbedderDb;
  const embedder = createChatSearchEmbedder(db, {
    recordUsage: async (record) => { recorded.push(record); },
    role: createEmbeddingModelRoleResolver(db, { loadRole: admit as unknown as EmbeddingRoleLoader }),
    runtime: { bindAdmitted }
  });
  return { admit, bindAdmitted, embed, embedder, policy, recorded };
}

describe("the past-chat embedder", () => {
  it("tells an unset role, an unusable role and a usable one apart, and never names another model", async () => {
    const unset = setup({ assigned: null });
    expect(await unset.embedder.currentModel()).toEqual({ kind: "unset" });
    expect(unset.admit).not.toHaveBeenCalled();
    // The model lost its credential, or its embedding evidence, or its embedding configuration.
    expect(await setup({ admit: async () => { throw new ProviderAdmissionError("credential_revoked"); } }).embedder.currentModel())
      .toEqual({ code: "credential_revoked", kind: "unavailable", providerModelId: "embed-a" });
    expect(await setup({ admit: async () => { throw new ProviderAdmissionError("model_not_available"); } }).embedder.currentModel())
      .toEqual({ code: "model_not_available", kind: "unavailable", providerModelId: "embed-a" });
    expect(await setup({ admit: async () => { throw new ProviderConfigurationError("provider_embedding_configuration_invalid"); } })
      .embedder.currentModel()).toEqual({ code: "model_not_available", kind: "unavailable", providerModelId: "embed-a" });
    // Reading the role failed (not the model): a content-free failure, never another model.
    await expect(setup({ admit: async () => { throw new Error("database down"); } }).embedder.currentModel())
      .rejects.toMatchObject({ code: "embedding_unavailable", message: "embedding_unavailable" });
    const usable = setup();
    expect(await usable.embedder.currentModel()).toEqual({ kind: "model", providerModelId: "embed-a" });
    expect(usable.admit).toHaveBeenCalledWith(expect.anything(), { providerModelId: "embed-a" });
  });

  it("binds the role it admitted, once per call, without admitting it again", async () => {
    const { admit, bindAdmitted, embedder } = setup();
    await embedder.embed(request());
    expect(admit).toHaveBeenCalledTimes(1);
    expect(bindAdmitted).toHaveBeenCalledWith({ authority: { providerModelId: "embed-a" } });
  });

  it("embeds with the role's adapter in the request's mode and latency class, one vector per text", async () => {
    const { embed, embedder, recorded } = setup();
    const signal = new AbortController().signal;
    expect(await embedder.embed(request({ latencyClass: "interactive", mode: "query", signal, texts: ["where did we stay"] })))
      .toEqual({ dimension: 3, vectors: [[0, 0.5, -1]] });
    expect(embed).toHaveBeenCalledWith({ latencyClass: "interactive", mode: "query", signal, texts: ["where did we stay"] });
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toEqual({
      costUsd: 0.000002, modelId: "upstream-embed", provider: "openrouter", providerModelId: "embed-a", purpose: "memory_retrieval",
      requestCount: 1, usage: { inputTokens: 12, totalTokens: 12 }, userId: "owner-1"
    });
  });

  it("records document embeddings as indexing", async () => {
    const { embedder, recorded } = setup();
    await embedder.embed(request());
    await vi.waitFor(() => expect(recorded).toEqual([expect.objectContaining({ purpose: "memory_indexing" })]));
  });

  it("refuses a model that is not the current role, before any provider call", async () => {
    const { embed, embedder } = setup({ assigned: "embed-b" });
    await expect(embedder.embed(request())).rejects.toMatchObject({ code: "embedding_model_changed" });
    const unset = setup({ assigned: null });
    await expect(unset.embedder.embed(request())).rejects.toMatchObject({ code: "embedding_model_changed" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("refuses an invalid batch", async () => {
    const { embed, embedder } = setup();
    for (const texts of [[], ["  "], Array.from({ length: 129 }, () => "x")]) {
      await expect(embedder.embed(request({ texts }))).rejects.toMatchObject({ code: "embedding_batch_invalid" });
    }
    expect(embed).not.toHaveBeenCalled();
  });

  it("maps a provider failure to its content-free code and retry hint, and records the usage the failed call reported", async () => {
    const { embedder, recorded } = setup({ embed: async () => {
      throw new EmbeddingAdapterError("embedding_provider_http_error", {
        httpStatus: 429, providerRequestCount: 2, retryAfterMs: 5_000, usage: { inputTokens: 7, totalTokens: 7 }
      });
    } });
    const error = await embedder.embed(request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatSearchEmbeddingError);
    expect(error).toMatchObject({ code: "embedding_provider_http_error", retryAfterMs: 5_000 });
    await vi.waitFor(() => expect(recorded).toEqual([expect.objectContaining({ requestCount: 2, usage: { inputTokens: 7, totalTokens: 7 } })]));
  });

  it("rejects a batch whose vectors miss a text or disagree in dimension, after recording the paid call", async () => {
    const short = setup({ embed: async () => ({ model: "m", requestId: null, usage: { inputTokens: 3, totalTokens: 3 }, vectors: [[1, 2]] }) });
    await expect(short.embedder.embed(request())).rejects.toMatchObject({ code: "embedding_response_count_mismatch" });
    await vi.waitFor(() => expect(short.recorded).toHaveLength(1));
    const ragged = setup({ embed: async () => ({ model: "m", requestId: null, usage: { inputTokens: 3, totalTokens: 3 }, vectors: [[1, 2], [1]] }) });
    await expect(ragged.embedder.embed(request())).rejects.toMatchObject({ code: "embedding_response_dimension_mismatch" });
    const invalid = setup({ embed: async () => ({ model: "m", requestId: null, usage: { inputTokens: 3, totalTokens: 3 }, vectors: [[1, Number.NaN], [1, 2]] }) });
    await expect(invalid.embedder.embed(request())).rejects.toMatchObject({ code: "embedding_response_vector_invalid" });
  });

  it("names an unusable role's code, and a cancelled or unknown failure without its message", async () => {
    const revoked = setup({ admit: async () => { throw new ProviderAdmissionError("credential_revoked"); } });
    await expect(revoked.embedder.embed(request())).rejects.toMatchObject({ code: "credential_revoked" });
    const controller = new AbortController();
    const cancelled = setup({ embed: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); } });
    await expect(cancelled.embedder.embed(request({ signal: controller.signal }))).rejects.toMatchObject({ code: "embedding_request_cancelled" });
    const unknown = setup({ embed: async () => { throw new Error("socket said something private"); } });
    const error = await unknown.embedder.embed(request()).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "embedding_provider_request_failed", message: "embedding_provider_request_failed" });
  });

  it("returns the vectors even when recording the usage fails", async () => {
    const embed = vi.fn(async () => ({ model: "m", requestId: null, usage: { inputTokens: 1, totalTokens: 1 }, vectors: [[1], [2]] }));
    const embedder = createChatSearchEmbedder({} as never, {
      recordUsage: () => { throw new Error("database down"); },
      role: { resolve: async () => ({ kind: "model", policyVersion: 1, providerModelId: "embed-a",
        role: {} as EmbeddingProviderAdmissionRole }) },
      runtime: { bindAdmitted: async () => ({ adapter: { embed },
        executionSnapshot: { model: { upstreamModelId: "u" }, providerFamily: "f" }, providerModelId: "embed-a" }) }
    });
    await expect(embedder.embed(request())).resolves.toEqual({ dimension: 1, vectors: [[1], [2]] });
  });
});
