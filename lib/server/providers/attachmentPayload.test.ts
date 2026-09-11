import { buildOpenAIResponsesRequest } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "./openRouterChatRequest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  providerAttachmentBudgetTokens,
  providerAttachmentPreviewText,
  providerAttachmentText,
  truncateProviderAttachmentText
} from "./attachmentPayload";
import type { ProviderAttachment, ProviderModelCapabilities, ProviderRunRequest } from "./types";

const textCapabilities: ProviderModelCapabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  pdf: true,
  reasoning: false,
  streaming: true,
  vision: true
};

function attachment(overrides: Partial<ProviderAttachment>): ProviderAttachment {
  return {
    byteSize: 42,
    extractedText: null,
    fileName: "attachment.txt",
    id: "attachment-1",
    kind: "document",
    metadata: {},
    mimeType: "text/plain",
    status: "ready",
    ...overrides
  };
}

describe("provider attachment payload helpers", () => {
  it.each([
    ["Responses", buildOpenAIResponsesRequest], ["OpenRouter", buildOpenRouterChatRequest],
    ["Anthropic", buildAnthropicMessagesRequest], ["Gemini", buildGeminiInteractionsRequest]
  ] as const)("sends only prepared text to a native-PDF-capable %s answer model", (_name, build) => {
    const file = attachment({ kind: "pdf", mimeType: "application/pdf", fileName: "report.pdf",
      pdfDelivery: "prepared_text", base64Data: "ORIGINAL_PDF_CANARY", extractedText: "PREPARED_TEXT_CANARY" });
    const request: ProviderRunRequest = { attachments: [file], attachmentIds: [file.id],
      content: { blocks: [{ type: "text", text: "Read the report" }] }, chatId: "chat",
      modelId: "fixture", provider: "fake", modelCapabilities: { ...textCapabilities, nativePdfInput: true },
      params: {}, prompt: { system: null, developer: null }, searchPlan: { mode: "all_selected", options: [] },
      knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 }, toolMode: "none" };
    const payload = JSON.stringify(build(request));
    expect(payload).toContain("PREPARED_TEXT_CANARY");
    expect(payload).not.toContain("ORIGINAL_PDF_CANARY");
    expect(providerAttachmentBudgetTokens({ attachments: [file], modelCapabilities: request.modelCapabilities }))
      .toBe(estimateApproxTokens(providerAttachmentText(file)));
  });

  it("uses the verified PDF count independently of binary size and prefers it to legacy processing", () => {
    for (const byteSize of [1024, 19_088_864]) {
      expect(providerAttachmentBudgetTokens({
        attachments: [attachment({ kind: "pdf", byteSize, metadata: { pdfPageCount: 2, pdf: { pageCount: 400 } } })],
        modelCapabilities: { ...textCapabilities, nativePdfInput: true }
      })).toBe(1024);
    }
  });

  it.each([undefined, null, 0, -1, 1.5, 501, Infinity, "2"])(
    "retains the unknown-PDF fallback for invalid page count %s", (pageCount) => {
      const pdf = attachment({ kind: "pdf", byteSize: 19_088_864,
        metadata: { pdfPageCount: pageCount, pdf: { pageCount } } });
      const modelCapabilities = { ...textCapabilities, nativePdfInput: true };
      expect(providerAttachmentBudgetTokens({ attachments: [pdf], modelCapabilities })).toBe(1_193_216);
      expect(providerAttachmentBudgetTokens({ attachments: [{ ...pdf, metadata: {
        pdfPageCount: pageCount, pdf: { pageCount: 2 }
      } }], modelCapabilities })).toBe(1024);
    }
  );

  it("builds the same extracted-text block shape used by provider adapters", () => {
    const doc = attachment({
      extractedText: "alpha,beta\n1,2\n",
      fileName: "rows.csv",
      kind: "document",
      mimeType: "text/csv"
    });

    expect(providerAttachmentText(doc)).toBe("[Attached document: rows.csv (text/csv)]\nalpha,beta\n1,2\n");
    expect(
      providerAttachmentBudgetTokens({
        attachments: [doc],
        modelCapabilities: textCapabilities
      })
    ).toBe(estimateApproxTokens(providerAttachmentText(doc)));
  });

  it("truncates extracted attachment text consistently", () => {
    expect(truncateProviderAttachmentText("abcdef", 3)).toBe("abc\n[truncated 3 chars]");
  });

  it("projects extracted attachment text to constant preview markers", () => {
    expect(providerAttachmentPreviewText(attachment({
      extractedText: "ATTACHMENT_TEXT_CANARY",
      fileName: "ATTACHMENT_FILENAME_CANARY",
      id: "ATTACHMENT_ID_CANARY",
      metadata: { storageKey: "ATTACHMENT_METADATA_CANARY" }
    }))).toBe("[Document attachment text omitted]");
    expect(providerAttachmentPreviewText(attachment({
      extractedText: "PDF_TEXT_CANARY",
      fileName: "PDF_FILENAME_CANARY",
      id: "PDF_ID_CANARY",
      kind: "pdf"
    }))).toBe("[PDF attachment text omitted]");
    expect(providerAttachmentPreviewText(attachment({ extractedText: "   " }))).toBeNull();
  });

  it("uses proxy estimates for native PDFs and images", () => {
    const nativePdf = attachment({
      byteSize: 2048,
      extractedText: "pdf text",
      fileName: "brief.pdf",
      kind: "pdf",
      metadata: {
        pdf: {
          pageCount: 2
        }
      },
      mimeType: "application/pdf"
    });
    const image = attachment({
      byteSize: 1024,
      fileName: "chart.png",
      kind: "image",
      metadata: {
        image: {
          height: 768,
          width: 1024
        }
      },
      mimeType: "image/png"
    });

    expect(
      providerAttachmentBudgetTokens({
        attachments: [nativePdf],
        modelCapabilities: {
          ...textCapabilities,
          nativePdfInput: true
        }
      })
    ).toBe(1024 + estimateApproxTokens("pdf text"));
    expect(
      providerAttachmentBudgetTokens({
        attachments: [image],
        modelCapabilities: textCapabilities
      })
    ).toBe(765);
  });
});
