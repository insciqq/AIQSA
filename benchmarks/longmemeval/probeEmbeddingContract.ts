export const LONGMEMEVAL_QUALIFICATION_OPERATOR_USER_ID =
  "00000000-0000-4000-8000-000000000001";

export type QualificationEmbeddingCandidate = Readonly<{
  activeConfig: unknown | null;
  activeVersion: number;
  connection: Readonly<{ enabled: boolean; family: string }>;
  enabled: boolean;
  id: string;
  modelClass: string;
  modelId: string;
}>;

export function selectedQualificationEmbeddingDeployment(
  candidates: readonly QualificationEmbeddingCandidate[],
  selectedProviderModelId: string | null
): QualificationEmbeddingCandidate {
  const selected = selectedProviderModelId
    ? candidates.find(({ id }) => id === selectedProviderModelId)
    : null;
  if (
    !selected?.activeConfig ||
    selected.activeVersion < 1 ||
    !selected.enabled ||
    !selected.connection.enabled ||
    selected.connection.family !== "openrouter" ||
    selected.modelClass !== "embedding" ||
    selected.modelId !== "qwen/qwen3-embedding-8b"
  ) {
    throw new Error("embedding_batch_probe_model_invalid");
  }
  return selected;
}
