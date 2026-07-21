import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  providerAttachmentBudgetTokens,
  providerAttachmentText,
  truncateProviderAttachmentText
} from "./attachmentPayload";
import type { ProviderAttachment, ProviderModelCapabilities } from "./types";

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
