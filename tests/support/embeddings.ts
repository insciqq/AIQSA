import { createHash } from "node:crypto";
import {
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS,
  MAX_EMBEDDING_INPUT_CHARS,
  MAX_EMBEDDING_REQUEST_BYTES,
  type EmbeddingAdapter,
  type EmbeddingMode
} from "@/lib/server/providers/embeddings";
import type { EmbeddingModelConfiguration } from "@/lib/server/providers/providerConfiguration";

function requestInputs(
  texts: readonly string[],
  mode: EmbeddingMode,
  configuration: EmbeddingModelConfiguration
): string[] {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_EMBEDDING_BATCH_INPUTS) {
    throw new EmbeddingAdapterError("embedding_batch_invalid");
  }
  if (mode !== "document" && mode !== "query") {
    throw new EmbeddingAdapterError("embedding_batch_invalid");
  }
  const prepared = texts.map((text) => {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MAX_EMBEDDING_INPUT_CHARS ||
      /\u0000/u.test(text)
    ) {
      throw new EmbeddingAdapterError("embedding_input_invalid");
    }
    return mode === "query" && configuration.queryInstructionTemplate
      ? configuration.queryInstructionTemplate.replace("{text}", () => text)
      : text;
  });
  if (Buffer.byteLength(JSON.stringify(prepared), "utf8") > MAX_EMBEDDING_REQUEST_BYTES) {
    throw new EmbeddingAdapterError("embedding_request_too_large");
  }
  return prepared;
}

function fakeVector(text: string, dimension: number, seed: string): number[] {
  const vector: number[] = [];
  for (let counter = 0; vector.length < dimension; counter += 1) {
    const digest = createHash("sha256")
      .update(seed, "utf8")
      .update("\u0000", "utf8")
      .update(text, "utf8")
      .update("\u0000", "utf8")
      .update(String(counter), "utf8")
      .digest();
    for (let offset = 0; offset + 4 <= digest.length && vector.length < dimension; offset += 4) {
      vector.push(digest.readInt32BE(offset) / 0x8000_0000);
    }
  }
  return vector;
}

function normalizedVector(vector: readonly number[], targetDimension: number): number[] {
  const squaredNorm = vector.slice(0, targetDimension)
    .reduce((total, value) => total + value * value, 0);
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new EmbeddingAdapterError("embedding_response_vector_invalid");
  }
  const norm = Math.sqrt(squaredNorm);
  return vector.slice(0, targetDimension).map((value) => value / norm);
}

export function createFakeEmbeddingAdapter(input: Readonly<{
  configuration: EmbeddingModelConfiguration;
  seed?: string;
}>): EmbeddingAdapter {
  const configuration = input.configuration;
  if (
    !Number.isSafeInteger(configuration.nativeDimension) ||
    !Number.isSafeInteger(configuration.targetDimension) ||
    configuration.targetDimension < 1 ||
    configuration.targetDimension > configuration.nativeDimension ||
    !configuration.supportsMrl && configuration.targetDimension !== configuration.nativeDimension
  ) {
    throw new EmbeddingAdapterError("embedding_input_invalid");
  }
  return {
    async embed(request) {
      const prepared = requestInputs(request.texts, request.mode, configuration);
      const inputTokens = prepared.reduce(
        (total, text) => total + Math.ceil(Buffer.byteLength(text, "utf8") / 4),
        0
      );
      return {
        model: "fake-embedding",
        requestId: null,
        usage: { inputTokens, totalTokens: inputTokens },
        vectors: prepared.map((text) => normalizedVector(
          fakeVector(text, configuration.nativeDimension, input.seed ?? "aiqsa"),
          configuration.targetDimension
        ))
      };
    }
  };
}
