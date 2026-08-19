import { describe, expect, it } from "vitest";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy,
  knowledgeVisionEgressApproved,
  knowledgeVisionProfileFromConfiguration,
  type KnowledgeVisionProfileDestination
} from "./knowledgeProfile";

const vision: KnowledgeVisionProfileDestination = {
  connectionDisplayName: "Vision provider",
  modelDisplayName: "Document vision",
  provider: "openai",
  providerModelId: "vision-model-1",
  supportsNativePdf: true
};

describe("Knowledge visual profile policy", () => {
  it("pins an optional exact destination and matching egress operation", () => {
    const configuration = knowledgeProfileConfiguration({
      candidateLimit: 40,
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: vision
    });
    const egress = knowledgeProfileEgressPolicy(vision);

    expect(knowledgeVisionProfileFromConfiguration(configuration)).toEqual({
      destination: vision,
      kind: "configured"
    });
    expect(knowledgeVisionEgressApproved(egress, "vision-model-1")).toBe(true);
    expect(knowledgeVisionEgressApproved(egress, "different-model")).toBe(false);
  });

  it("treats legacy and explicit null profiles as asset-only and rejects malformed approval", () => {
    expect(knowledgeVisionProfileFromConfiguration({ schemaVersion: 1 })).toEqual({
      kind: "asset_only"
    });
    expect(knowledgeVisionProfileFromConfiguration(knowledgeProfileConfiguration({
      candidateLimit: 40,
      resultLimit: 8,
      scoreThreshold: 0.01,
      visionDestination: null
    }))).toEqual({ kind: "asset_only" });
    expect(knowledgeVisionProfileFromConfiguration({
      schemaVersion: 2,
      visualAnalysis: { ...vision, providerModelId: "bad\nmodel" }
    })).toEqual({ kind: "invalid" });
    expect(knowledgeVisionEgressApproved({
      operations: [{
        operation: "vision_analysis",
        providerModelId: "vision-model-1",
        representations: ["visual_queries", "visual_source_bytes"]
      }],
      policyVersion: "knowledge-profile-egress-v2"
    }, "vision-model-1")).toBe(false);
  });
});
