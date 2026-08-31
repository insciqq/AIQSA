import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1,
  selectKnowledgeAnswerPipelineForNewRun
} from "./answerPipelineRollout";

describe("Knowledge answer pipeline rollout", () => {
  it("keeps the code-owned V21 canary disabled by default", () => {
    expect(KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1).toEqual({
      defaultPipeline: "v20_v16",
      v21CanaryBasisPoints: 0,
      version: 1
    });
    expect(selectKnowledgeAnswerPipelineForNewRun({ modelRunId: "run-default-1" }))
      .toBe("v20_v16");
  });

  it("selects deterministically at the rollout boundaries", () => {
    expect(selectKnowledgeAnswerPipelineForNewRun({
      modelRunId: "run-canary-1",
      rollout: { defaultPipeline: "v20_v16", v21CanaryBasisPoints: 10_000, version: 1 }
    })).toBe("v21_scope_v4");
    const rollout = {
      defaultPipeline: "v20_v16" as const,
      v21CanaryBasisPoints: 5_000,
      version: 1 as const
    };
    expect(selectKnowledgeAnswerPipelineForNewRun({
      modelRunId: "run-stable-bucket",
      rollout
    })).toBe(selectKnowledgeAnswerPipelineForNewRun({
      modelRunId: "run-stable-bucket",
      rollout
    }));
  });

  it("rejects invalid code-owned policy values", () => {
    expect(() => selectKnowledgeAnswerPipelineForNewRun({
      modelRunId: "run-invalid",
      rollout: {
        defaultPipeline: "v20_v16",
        v21CanaryBasisPoints: 10_001,
        version: 1
      }
    })).toThrow("knowledge_answer_pipeline_rollout_invalid");
  });
});
