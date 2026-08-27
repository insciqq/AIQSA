import {
  DEFAULT_MEMORY_EMBEDDING_BATCH_SIZE,
  MAX_MEMORY_EMBEDDING_BATCH_SIZE
} from "./contract";

export const MEMORY_EMBEDDING_BATCH_SIZE_ENV =
  "AIQSA_MEMORY_EMBEDDING_BATCH_SIZE";

export function loadMemoryEmbeddingBatchSize(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[MEMORY_EMBEDDING_BATCH_SIZE_ENV];
  if (raw === undefined || raw === "") {
    return DEFAULT_MEMORY_EMBEDDING_BATCH_SIZE;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error("memory_embedding_batch_size_environment_invalid");
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEMORY_EMBEDDING_BATCH_SIZE
  ) {
    throw new Error("memory_embedding_batch_size_environment_invalid");
  }
  return value;
}
