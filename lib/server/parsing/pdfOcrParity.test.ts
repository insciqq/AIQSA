// @vitest-environment node
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { PDF_PROCESSING_MAX_PAGES } from "../../contracts/uploads";
import { createKnowledgeModelPdfParser } from "../knowledge/modelPdfParser";
import { KNOWLEDGE_PDF_PARSER_PROFILE_VERSION } from "../knowledge/knowledgeProfile";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderRunRequest } from "../providers/types";
import type { ChatPdfAttachmentAdmission } from "../uploads/chatPdfAdmission";
import { CHAT_PDF_PARSER_VERSION, createChatPdfCore } from "../uploads/chatPdfCore";
import { finalizeParsedDocument } from "./assessment";
import { modelPdfPageEndMarker, modelPdfPageStartMarker } from "./modelPdfOutput";
import type { NativePdfGeometry } from "./nativePdf";
import type { ParsedDocumentBlock } from "./types";

function geometry(): NativePdfGeometry {
  const blocks: ParsedDocumentBlock[] = [
    "The radius is q i ≤ 7 s i.", "Calibration completed on 2043-05-06."
  ].map((text, index) => ({ text, index, readingOrder: index, page: 1, pageEnd: 1,
    type: "paragraph", table: null, isTable: false, assetIds: [], headingPath: [], languageHints: [],
    boundingBoxes: [{ page: 1, coordinateOrigin: "bottom_left", left: 20, right: 180,
      top: 170 - index * 30, bottom: 155 - index * 30 }] }));
  return { blocks, pageCount: 1, classification: "native_text", quality: {
    visualGroupOverflow: false, pages: [{ page: 1, classification: "native_text",
      characterCount: 100, rowCount: 2, textItemCount: 2, imageCount: 1,
      duplicateTextItemCount: 0, invalidCharacterCount: 0, invisibleText: false,
      maxVisualGroupCount: 1, multiGroupRowCount: 0, outOfBoundsTextItemCount: 0,
      overlappingTextItemCount: 0, pageBottom: 0, pageLeft: 0, pageRight: 200, pageTop: 200,
      pageRotation: 0, rotatedTextItemCount: 0, shortRowCount: 0, textAreaRatio: 0.1,
      vectorGraphicsOperationCount: 0, visualGroupOverflow: false }]
  } };
}

function snapshot(): ProviderExecutionSnapshot {
  return normalizeProviderExecutionSnapshot({ version: 1, connectionId: "connection",
    credentialId: "credential", credentialVersionId: "credential-version", providerModelId: "model",
    providerFamily: "openai_compatible", modelDisplayName: "Fixture", connectionDisplayName: "Fixture",
    connection: { apiRoot: "https://ocr.example.test/v1", allowPrivateNetwork: false,
      authenticationMode: "bearer", responseTimeoutMs: 300_000 },
    model: { adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer",
      upstreamModelId: "fixture-model", defaultParams: {}, capabilities: {
        nativePdfInput: false, nativeSearch: false, pdf: true, vision: true, reasoning: false,
        streaming: true, contextWindow: 128_000, defaultMaxOutputTokens: 8192
      } }
  });
}

describe("attachment and Knowledge OCR parity", () => {
  it.each(["no_native", "native", "layout", "math_native_layer"] as const)(
    "keeps the same images, prompt, math, table columns and native omissions with %s", async route => {
      const bytes = Buffer.from("%PDF-neutral-parity-source");
      const image = await sharp({ create: { width: 200, height: 200, channels: 3, background: "white" } })
        .png().toBuffer();
      const originalNative = geometry();
      const native = route === "math_native_layer" ? { ...originalNative, quality: {
        ...originalNative.quality, pages: originalNative.quality.pages.map(page => ({ ...page, imageCount: 0 }))
      } } : originalNative;
      const extractGeometry = vi.fn(async () => {
        if (route === "no_native") throw new Error("native_unavailable");
        return native;
      });
      const parseDocling = route === "layout" || route === "math_native_layer" ? vi.fn(async () => finalizeParsedDocument({
        blocks: native.blocks, engine: "docling", mediaType: "application/pdf", pageCount: 1, status: "complete"
      })) : null;
      const inspect = vi.fn(async () => ({ pageCount: 1 }));
      const prepare = vi.fn(async () => ({ kind: "images" as const, pageStart: 1, pageEnd: 1,
        images: [{ bytes: image, width: 200, height: 200, sourceWidth: 200, sourceHeight: 200,
          page: 1, mimeType: "image/png" as const }] }));
      const binding = snapshot();
      const admitted: ChatPdfAttachmentAdmission = {
        attachmentId: "attachment", byteSize: bytes.length, pageCount: 1,
        sourceChecksum: createHash("sha256").update(bytes).digest("hex"), route: "system_vision",
        policyVersion: 3, snapshot: binding,
        authority: { connectionId: "connection", connectionVersion: 1, credentialId: "credential",
          credentialVersionId: "credential-version", providerModelId: "model", modelVersion: 1 }
      };
      const formula = "\\[\nr=\\frac{a+5}{b}\n\\]";
      const modelText = [modelPdfPageStartMarker(1), String.raw`The radius is \(q_i\leq\sqrt{7}\,s_i\).`,
        formula, "Region\tMeasure\tValue", "West\tA\t7", "\tB\t11", modelPdfPageEndMarker(1)].join("\n");
      const core = createChatPdfCore({ inspect, extractGeometry, parseDocling, prepare });
      const planned = await core.plan({ admission: admitted, bytes, onPageCount: async () => undefined });
      const chatPage = await core.page({ admission: admitted, bytes, ...planned, page: 1 });
      const chat = core.assemble({ admission: admitted, ...planned, results: [{ page: 1, text: modelText }] });
      const execute = vi.fn(async (_snapshot: ProviderExecutionSnapshot, request: ProviderRunRequest) => {
        void _snapshot; void request;
        return { finalText: modelText, finalProviderResponsePreview: {},
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 } };
      });
      const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
        inspect, extractGeometry, parseDocling, prepare, execute: execute as never,
        attemptRepository: {
          reserve: vi.fn(async () => ({ kind: "dispatch", attemptId: "attempt" })),
          markDispatched: vi.fn(async () => true), markAmbiguous: vi.fn(),
          settle: vi.fn(async (value: Record<string, unknown>) => value)
        } as never
      });
      const knowledge = await parser.parse({ artifactId: "artifact", bytes, ownerUserId: "owner",
        maxBlocks: planned.plan.maxBlocks, maxCharacters: planned.plan.maxCharacters,
        maxPages: PDF_PROCESSING_MAX_PAGES, mode: "system_model_vision",
        parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION, processingGeneration: 0,
        profileRevisionId: "profile", sourceVersionId: "source-version", systemModelPolicyVersion: 3,
        systemModelSnapshot: binding });
      expect(CHAT_PDF_PARSER_VERSION).toBe(KNOWLEDGE_PDF_PARSER_PROFILE_VERSION);
      expect(execute).toHaveBeenCalledOnce();
      expect({ ...chatPage.request, chatId: "knowledge-pdf-transcription" }).toEqual(execute.mock.calls[0]![1]);
      expect(prepare.mock.calls).toHaveLength(2);
      expect(chat).toEqual(knowledge);
      expect(chat.blocks.some(block => block.text === formula)).toBe(true);
      expect(chat.blocks.find(block => block.table)?.table?.cells)
        .toContainEqual({ row: 2, column: 0, rowSpan: 1, columnSpan: 1, text: "" });
      expect(chat.text).not.toContain("The radius is q i ≤ 7 s i.");
      expect(chat.text.includes("Calibration completed on 2043-05-06."))
        .toBe(route !== "no_native");
    }
  );
});
