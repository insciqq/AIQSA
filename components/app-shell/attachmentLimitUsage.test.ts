import type { CatalogModel } from "@/components/app-shell/types";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { CatalogAttachmentLimits } from "@/lib/contracts/catalog";
import { describe, expect, it } from "vitest";
import { calculateAttachmentLimitUsage } from "./attachmentLimitUsage";

const limits: CatalogAttachmentLimits = {
  maxCount: 5,
  maxEncodedBytes: 1_000,
  maxMaterializedBytes: 750
};

function model(
  documentInputMode: CatalogModel["capabilities"]["documentInputMode"],
  imageInput = true
): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode,
      imageInput,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      toolCalling: false
    },
    contextWindow: 4096,
    defaultParams: {},
    displayName: "Test model",
    modelId: "test-model",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
      reasoningEffort: {
        defaultValue: "none",
        options: ["none"],
        supported: false
      },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "test-provider",
    searchStrategyIds: ["search-disabled"]
  };
}

const attachments: ComposerAttachment[] = [
  {
    byteSize: 3,
    fileName: "evidence.png",
    id: "image-1",
    kind: "image",
    mimeType: "image/png"
  },
  {
    byteSize: 6,
    fileName: "paper.pdf",
    id: "pdf-1",
    kind: "pdf",
    mimeType: "application/pdf"
  },
  {
    byteSize: 100,
    fileName: "notes.md",
    id: "document-1",
    kind: "document",
    mimeType: "text/markdown"
  }
];

describe("attachment limit usage", () => {
  it("counts unique files and charges only the selected model's binary subset", () => {
    const native = calculateAttachmentLimitUsage(
      [...attachments, { ...attachments[0]!, fileName: "duplicate.png" }],
      model("native_pdf"),
      limits
    );
    const extraction = calculateAttachmentLimitUsage(
      attachments,
      model("pdf_text_extraction"),
      limits
    );

    expect(native).toMatchObject({
      binaryAttachmentCount: 2,
      count: 3,
      encodedBytes: 34,
      materializedBytes: 9,
      summary: "3 files · 109 bytes",
      totalSourceBytes: 109
    });
    expect(extraction).toMatchObject({
      binaryAttachmentCount: 1,
      count: 3,
      encodedBytes: 26,
      materializedBytes: 3
    });
  });

  it("warns at each inclusive 80 percent boundary and accepts exact limits", () => {
    const countUsage = calculateAttachmentLimitUsage(
      Array.from({ length: 4 }, (_, index) => ({
        byteSize: 1,
        fileName: `${index}.md`,
        id: `document-${index}`,
        kind: "document" as const
      })),
      model("pdf_text_extraction", false),
      limits
    );
    const sourceUsage = calculateAttachmentLimitUsage(
      [{ byteSize: 600, fileName: "scan.pdf", id: "pdf", kind: "pdf" }],
      model("native_pdf", false),
      limits
    );
    const exactUsage = calculateAttachmentLimitUsage(
      [{ byteSize: 750, fileName: "scan.pdf", id: "pdf", kind: "pdf" }],
      model("native_pdf", false),
      { ...limits, maxEncodedBytes: 1_000 }
    );

    expect(countUsage).toMatchObject({
      blocking: false,
      feedback: "4 of 5 attachments selected.",
      tone: "caution"
    });
    expect(sourceUsage.feedback).toContain(
      "Selected attachments require about 600 bytes of the 750 bytes attachment-data limit."
    );
    expect(exactUsage).toMatchObject({ blocking: false, tone: "caution" });
  });

  it("reports every exceeded boundary with exact corrective facts", () => {
    const usage = calculateAttachmentLimitUsage(
      Array.from({ length: 6 }, (_, index) => ({
        byteSize: 200,
        fileName: `${index}.png`,
        id: `image-${index}`,
        kind: "image" as const,
        mimeType: "image/png"
      })),
      model("none"),
      limits
    );

    expect(usage).toMatchObject({ blocking: true, tone: "critical" });
    expect(usage.feedback).toContain(
      "6 attachments selected. Remove at least 1 attachment before sending."
    );
    expect(usage.feedback).toContain("750 bytes attachment-data limit");
    expect(usage.feedback).toContain("1000 bytes provider-input limit");
  });

  it("keeps a count-only summary when stored attachment bytes are unavailable", () => {
    expect(
      calculateAttachmentLimitUsage(
        [{ fileName: "stored.pdf", id: "stored", kind: "pdf" }],
        model("native_pdf"),
        limits
      )
    ).toMatchObject({
      blocking: false,
      summary: "1 file",
      totalSourceBytes: 0
    });
  });

  it("uses conservative shared defaults while catalog or model data is unavailable", () => {
    const fallback = calculateAttachmentLimitUsage(
      Array.from({ length: 21 }, (_, index) => ({
        byteSize: 1,
        fileName: `${index}.pdf`,
        id: `pdf-${index}`,
        kind: "pdf" as const,
        mimeType: "application/pdf"
      })),
      undefined,
      undefined
    );

    expect(fallback).toMatchObject({
      binaryAttachmentCount: 21,
      blocking: true,
      count: 21,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 100_663_296,
        maxMaterializedBytes: 67_108_864
      }
    });
  });
});
