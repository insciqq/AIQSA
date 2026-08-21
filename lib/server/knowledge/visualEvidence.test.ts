import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeVisualAnalysisResult,
  KNOWLEDGE_VISUAL_ANALYSIS_VERSION
} from "./visualEvidence";

function availableReceipt() {
  return {
    assetId: "asset-1",
    blockId: "block-1",
    boundingBoxes: [{
      bottom: 200,
      coordinateOrigin: "top_left",
      left: 10,
      page: 2,
      right: 300,
      top: 20
    }],
    caption: "Quarterly revenue",
    description: "Revenue increases in every quarter.",
    headingPath: ["Results"],
    kind: "chart",
    label: "Quarterly revenue",
    page: 2,
    provider: {
      modelId: "vision-model",
      profileRevisionId: "profile-revision-1",
      provider: "test",
      providerModelId: "vision-upstream",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        reasoningTokens: 0,
        totalTokens: 28
      }
    },
    status: "available",
    version: KNOWLEDGE_VISUAL_ANALYSIS_VERSION,
    warnings: []
  } as const;
}

describe("historical Knowledge visual evidence decoder", () => {
  it("decodes an immutable attributable receipt", () => {
    expect(decodeKnowledgeVisualAnalysisResult(availableReceipt())).toMatchObject({
      blockId: "block-1",
      boundingBoxes: [{ page: 2 }],
      provider: { usage: { totalTokens: 28 } },
      status: "available"
    });
  });

  it("decodes a closed unavailable receipt without provider output", () => {
    expect(decodeKnowledgeVisualAnalysisResult({
      ...availableReceipt(),
      description: null,
      provider: null,
      status: "unavailable",
      warnings: ["analysis_unavailable"]
    })).toMatchObject({
      description: null,
      provider: null,
      status: "unavailable",
      warnings: ["analysis_unavailable"]
    });
  });

  it("rejects query-time shaped, unattributed, or extended payloads", () => {
    expect(decodeKnowledgeVisualAnalysisResult({
      ...availableReceipt(),
      provider: null
    })).toBeNull();
    expect(decodeKnowledgeVisualAnalysisResult({
      ...availableReceipt(),
      query: "inspect the chart"
    })).toBeNull();
  });
});
