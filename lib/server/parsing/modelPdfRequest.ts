import { createHash } from "node:crypto";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderAttachment, ProviderRunRequest } from "../providers/types";
import type { AdaptivePdfVisionSupplement } from "./adaptivePdfVision";
import type { PdfModelProcessingMode, PreparedPdfBatch } from "./pdfPreparation";

export type PdfVisionDetail = "auto" | "original";

// Keep the original request labels and digests stable for accepted Knowledge
// generations. Callers own storage, authority, dispatch, and accounting.
export function digestPreparedPdfBatch(input: Readonly<{
  batch: PreparedPdfBatch;
  mode: PdfModelProcessingMode;
  profileRevisionId: string;
  prompt: string;
  snapshot: ProviderExecutionSnapshot;
  supplement: AdaptivePdfVisionSupplement | null;
  visionDetail: PdfVisionDetail;
}>): string {
  const hash = createHash("sha256");
  hash.update(input.visionDetail === "original"
    ? "knowledge-model-pdf-request-v2\0"
    : "knowledge-model-pdf-request-v1\0", "utf8");
  hash.update(input.mode, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.profileRevisionId, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.snapshot.providerModelId, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.snapshot.credentialVersionId ?? "", "utf8");
  hash.update("\0", "utf8");
  hash.update(input.prompt, "utf8");
  if (input.visionDetail === "original") {
    hash.update("\0original", "utf8");
  }
  if (input.batch.kind === "pdf") {
    hash.update(input.batch.bytes);
  } else {
    for (const image of input.batch.images) {
      if (input.visionDetail === "original") {
        hash.update("\0", "utf8");
        hash.update(JSON.stringify({
          height: image.height,
          mimeType: image.mimeType,
          page: image.page,
          width: image.width
        }), "utf8");
      }
      hash.update(image.bytes);
    }
  }
  if (input.supplement) {
    hash.update("\0adaptive-pdf-supplement-v1\0", "utf8");
    hash.update(input.supplement.nativePageText ?? "", "utf8");
    for (const crop of input.supplement.crops) {
      hash.update("\0", "utf8");
      hash.update(JSON.stringify({
        height: crop.height,
        index: crop.index,
        mimeType: crop.mimeType,
        nativeText: crop.nativeText,
        page: crop.page,
        width: crop.width
      }), "utf8");
      hash.update(crop.bytes);
    }
  }
  return hash.digest("hex");
}

function attachments(
  batch: PreparedPdfBatch,
  visionDetail: PdfVisionDetail,
  supplement: AdaptivePdfVisionSupplement | null
): ProviderAttachment[] {
  if (batch.kind === "pdf") {
    return [{
      base64Data: batch.bytes.toString("base64"),
      byteSize: batch.bytes.byteLength,
      extractedText: null,
      fileName: `pages-${String(batch.pageStart).padStart(6, "0")}-${String(batch.pageEnd).padStart(6, "0")}.pdf`,
      id: "knowledge-pdf-range",
      kind: "pdf",
      metadata: {
        pdf: {
          pageCount: batch.pageEnd - batch.pageStart + 1,
          sourcePageEnd: batch.pageEnd,
          sourcePageStart: batch.pageStart
        }
      },
      mimeType: "application/pdf",
      status: "ready"
    }];
  }
  const pages = batch.images.map((image): ProviderAttachment => {
    const pageName = `page-${String(image.page).padStart(6, "0")}`;
    return {
      byteSize: image.bytes.byteLength,
      dataUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      extractedText: null,
      fileName: `${pageName}.${
        image.mimeType === "image/png" ? "png" : "jpg"
      }`,
      id: `knowledge-pdf-page-${image.page}`,
      kind: "image",
      metadata: {
        image: {
          detail: visionDetail,
          height: image.height,
          sourcePage: image.page,
          width: image.width
        }
      },
      mimeType: image.mimeType,
      status: "ready"
    };
  });
  const crops: ProviderAttachment[] = (supplement?.crops ?? []).map((crop) => {
    const pageName = `page-${String(crop.page).padStart(6, "0")}-table-crop-${crop.index + 1}`;
    return {
      byteSize: crop.bytes.byteLength,
      dataUrl: `data:${crop.mimeType};base64,${crop.bytes.toString("base64")}`,
      extractedText: null,
      fileName: `${pageName}.${crop.mimeType === "image/png" ? "png" : "jpg"}`,
      id: `knowledge-pdf-page-${crop.page}-table-crop-${crop.index + 1}`,
      kind: "image",
      metadata: {
        image: {
          detail: "original",
          height: crop.height,
          sourcePage: crop.page,
          width: crop.width
        }
      },
      mimeType: crop.mimeType,
      status: "ready"
    };
  });
  return [...pages, ...crops];
}

export function modelPdfProviderRequest(input: Readonly<{
  batch: PreparedPdfBatch;
  mode: PdfModelProcessingMode;
  prompt: string;
  snapshot: ProviderExecutionSnapshot;
  supplement: AdaptivePdfVisionSupplement | null;
  visionDetail: PdfVisionDetail;
}>): ProviderRunRequest {
  const files = attachments(input.batch, input.visionDetail, input.supplement);
  const declaredOutput = input.snapshot.model.capabilities.defaultMaxOutputTokens;
  const maxOutputTokens = typeof declaredOutput === "number" &&
    Number.isSafeInteger(declaredOutput) && declaredOutput > 0
    ? Math.min(32_768, declaredOutput)
    : 16_384;
  return {
    attachmentIds: files.map((attachment) => attachment.id),
    attachments: files,
    chatId: "knowledge-pdf-transcription",
    content: { blocks: [{ text: input.prompt, type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      ...input.snapshot.model.capabilities,
      nativePdfInput: input.mode === "system_model_direct_pdf"
    },
    modelId: input.snapshot.model.upstreamModelId,
    params: {
      ...input.snapshot.model.defaultParams,
      background: false,
      maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false
    },
    prompt: { developer: null, system: null },
    provider: input.snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}
