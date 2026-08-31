import { createHash } from "node:crypto";

export type KnowledgeAnswerPipeline = "v20_v16" | "v21_audit_v2";

export type KnowledgeAnswerPipelineRolloutV1 = Readonly<{
  defaultPipeline: "v20_v16";
  v21CanaryBasisPoints: number;
  version: 1;
}>;

/** Code-owned rollout for newly admitted runs. V21 remains fully recoverable
 * when this value changes because accepted runs are selected from their first
 * persisted operation, never from the current rollout. */
export const KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1 = Object.freeze({
  defaultPipeline: "v20_v16",
  v21CanaryBasisPoints: 0,
  version: 1
} as const satisfies KnowledgeAnswerPipelineRolloutV1);

export function selectKnowledgeAnswerPipelineForNewRun(input: Readonly<{
  modelRunId: string;
  rollout?: KnowledgeAnswerPipelineRolloutV1;
}>): KnowledgeAnswerPipeline {
  const rollout = input.rollout ?? KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1;
  if (!input.modelRunId.trim() || input.modelRunId.length > 512 ||
    rollout.version !== 1 || rollout.defaultPipeline !== "v20_v16" ||
    !Number.isSafeInteger(rollout.v21CanaryBasisPoints) ||
    rollout.v21CanaryBasisPoints < 0 || rollout.v21CanaryBasisPoints > 10_000) {
    throw new Error("knowledge_answer_pipeline_rollout_invalid");
  }
  if (rollout.v21CanaryBasisPoints === 0) return rollout.defaultPipeline;
  if (rollout.v21CanaryBasisPoints === 10_000) return "v21_audit_v2";
  const bucket = Number.parseInt(createHash("sha256")
    .update(`aiqsa:knowledge-answer-rollout:v1:${input.modelRunId}`, "utf8")
    .digest("hex")
    .slice(0, 8), 16) % 10_000;
  return bucket < rollout.v21CanaryBasisPoints
    ? "v21_audit_v2"
    : rollout.defaultPipeline;
}
