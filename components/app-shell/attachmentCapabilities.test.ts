import { describe, expect, it } from "vitest";
import type { CatalogModel } from "./types";
import { partitionAttachmentsForModel } from "./attachmentCapabilities";

function model(
  documentInputMode: CatalogModel["capabilities"]["documentInputMode"],
  imageInput: boolean
): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode,
      imageInput,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true
    },
    contextWindow: 4096,
    defaultParams: {},
    displayName: "Test model",
    modelId: "test-model",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
      reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "test",
    searchStrategyIds: ["search-disabled"]
  };
}

const attachments = [
  { fileName: "notes.txt", id: "document", kind: "document" as const },
  { fileName: "image.png", id: "image", kind: "image" as const },
  { fileName: "paper.pdf", id: "pdf", kind: "pdf" as const }
];

describe("attachment capabilities", () => {
  it("reconciles staged files when a model changes", () => {
    expect(partitionAttachmentsForModel(attachments, model("none", true))).toEqual({
      supported: [attachments[0], attachments[1]],
      unsupported: [attachments[2]]
    });

    expect(
      partitionAttachmentsForModel(attachments, model("pdf_text_extraction", false))
    ).toEqual({
      supported: [attachments[0], attachments[2]],
      unsupported: [attachments[1]]
    });
  });
});
