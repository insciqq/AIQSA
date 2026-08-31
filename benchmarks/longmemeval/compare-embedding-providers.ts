import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modelId = "qwen/qwen3-embedding-8b";
const endpointCatalogUrl = `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
const embeddingsUrl = "https://openrouter.ai/api/v1/embeddings";
const repeats = 2;
const targetDimension = 1_536;
const inputs = Object.freeze([
  "Instruct: Retrieve evidence passages from a private document knowledge base that best answer the query. Preserve exact names, identifiers, dates, numbers, units, and constraints.\nQuery: Which provider served the embedding request?",
  "The user moved from Lisbon to Helsinki on 14 February 2025.",
  "Order ZX-4817 contains 23 cobalt fasteners and ships on Tuesday.",
  "Пользователь предпочитает зелёный чай без сахара.",
  "用户计划在九月访问京都。",
  "A bounded retrieval engine must preserve exact identifiers, dates, and units."
]);

type Endpoint = Readonly<{
  quantization: string | null;
  status: number;
  tag: string;
}>;

type EmbeddingResponse = Readonly<{
  data: readonly Readonly<{ embedding: readonly number[]; index: number }>[];
  model: string;
}>;

type ProviderSample = Readonly<{
  elapsedMs: number;
  vectors: readonly (readonly number[])[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSecret(): string {
  const secret = process.env.OPENROUTER_API_KEY?.trim();
  if (!secret) throw new Error("embedding_provider_comparison_credential_missing");
  return secret;
}

function normalized(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("embedding_provider_comparison_vector_invalid");
  }
  return vector.map((value) => value / norm);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("embedding_provider_comparison_dimension_mismatch");
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  return dot;
}

function maxAbsoluteDelta(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("embedding_provider_comparison_dimension_mismatch");
  }
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!));
  }
  return maximum;
}

function similarityMatrix(vectors: readonly (readonly number[])[]): number[] {
  const matrix: number[] = [];
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      matrix.push(cosine(vectors[left]!, vectors[right]!));
    }
  }
  return matrix;
}

async function activeEndpoints(): Promise<Endpoint[]> {
  const response = await fetch(endpointCatalogUrl, {
    headers: { accept: "application/json" },
    redirect: "error"
  });
  if (!response.ok) throw new Error("embedding_provider_comparison_catalog_failed");
  const value = await response.json() as unknown;
  const data = isRecord(value) && isRecord(value.data) ? value.data : null;
  const endpoints = data && Array.isArray(data.endpoints) ? data.endpoints : null;
  if (!endpoints) throw new Error("embedding_provider_comparison_catalog_invalid");
  return endpoints.map((endpoint) => {
    if (!isRecord(endpoint) || typeof endpoint.tag !== "string" ||
      typeof endpoint.status !== "number" ||
      endpoint.quantization !== null && typeof endpoint.quantization !== "string") {
      throw new Error("embedding_provider_comparison_catalog_invalid");
    }
    return {
      quantization: endpoint.quantization,
      status: endpoint.status,
      tag: endpoint.tag
    };
  }).filter(({ status }) => status === 0);
}

async function embed(secret: string, provider: string): Promise<ProviderSample> {
  const startedAt = performance.now();
  const response = await fetch(embeddingsUrl, {
    body: JSON.stringify({
      encoding_format: "float",
      input: inputs,
      model: modelId,
      provider: {
        allow_fallbacks: false,
        data_collection: "deny",
        only: [provider],
        order: [provider]
      }
    }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    },
    method: "POST",
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(`embedding_provider_comparison_request_failed:${provider}:${response.status}`);
  }
  const value = await response.json() as EmbeddingResponse;
  if (value.model.toLowerCase() !== modelId || value.data.length !== inputs.length) {
    throw new Error("embedding_provider_comparison_response_invalid");
  }
  const ordered: Array<readonly number[] | undefined> = new Array(inputs.length);
  for (const item of value.data) ordered[item.index] = item.embedding;
  if (ordered.some((vector) => !vector)) {
    throw new Error("embedding_provider_comparison_response_invalid");
  }
  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    vectors: ordered.map((vector) => normalized(vector!))
  };
}

function projected(vectors: readonly (readonly number[])[]): readonly (readonly number[])[] {
  return vectors.map((vector) => normalized(vector.slice(0, targetDimension)));
}

function comparisonMetrics(
  left: readonly (readonly number[])[],
  right: readonly (readonly number[])[]
): Readonly<{
  maxAbsoluteDelta: number;
  maxSimilarityMatrixDelta: number;
  meanCosine: number;
  minCosine: number;
}> {
  const cosines = left.map((vector, index) => cosine(vector, right[index]!));
  const deltas = left.map((vector, index) => maxAbsoluteDelta(vector, right[index]!));
  return {
    maxAbsoluteDelta: Math.max(...deltas),
    maxSimilarityMatrixDelta: maxAbsoluteDelta(
      similarityMatrix(left),
      similarityMatrix(right)
    ),
    meanCosine: cosines.reduce((sum, value) => sum + value, 0) / cosines.length,
    minCosine: Math.min(...cosines)
  };
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  if (process.env.AIQSA_MEMORY_BENCHMARK_ACK !== "DISPOSABLE_PAID_LONGMEMEVAL" ||
    process.env.AIQSA_MEMORY_EGRESS_CONSENT_MODE !== "ADMIN") {
    throw new Error("embedding_provider_comparison_authority_required");
  }
  const secret = requireSecret();
  const endpoints = await activeEndpoints();
  if (endpoints.length < 2) throw new Error("embedding_provider_comparison_routes_missing");

  const samples = new Map<string, readonly ProviderSample[]>();
  for (const endpoint of endpoints) {
    const providerSamples: ProviderSample[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      providerSamples.push(await embed(secret, endpoint.tag));
    }
    samples.set(endpoint.tag, providerSamples);
  }

  const withinProvider = endpoints.map((endpoint) => {
    const providerSamples = samples.get(endpoint.tag)!;
    return {
      elapsedMs: providerSamples.map(({ elapsedMs }) => elapsedMs),
      native: {
        dimension: providerSamples[0]!.vectors[0]!.length,
        ...comparisonMetrics(providerSamples[0]!.vectors, providerSamples[1]!.vectors)
      },
      provider: endpoint.tag,
      quantization: endpoint.quantization,
      target: {
        dimension: targetDimension,
        ...comparisonMetrics(
          projected(providerSamples[0]!.vectors),
          projected(providerSamples[1]!.vectors)
        )
      }
    };
  });

  const crossProvider: Array<Record<string, number | string>> = [];
  for (let left = 0; left < endpoints.length; left += 1) {
    for (let right = left + 1; right < endpoints.length; right += 1) {
      const leftVectors = samples.get(endpoints[left]!.tag)![0]!.vectors;
      const rightVectors = samples.get(endpoints[right]!.tag)![0]!.vectors;
      crossProvider.push({
        ...Object.fromEntries(Object.entries(comparisonMetrics(leftVectors, rightVectors))
          .map(([key, value]) => [`native${key[0]!.toUpperCase()}${key.slice(1)}`, value])),
        providers: `${endpoints[left]!.tag}:${endpoints[right]!.tag}`,
        ...Object.fromEntries(Object.entries(comparisonMetrics(
          projected(leftVectors),
          projected(rightVectors)
        )).map(([key, value]) => [`target${key[0]!.toUpperCase()}${key.slice(1)}`, value]))
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    crossProvider,
    event: "embedding_provider_comparison_complete",
    inputCount: inputs.length,
    modelId,
    repeats,
    withinProvider
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "embedding_provider_comparison_failed";
  process.stderr.write(`${/^[A-Za-z0-9_:/.-]{1,240}$/u.test(message)
    ? message
    : "embedding_provider_comparison_failed"}\n`);
  process.exitCode = 1;
});
