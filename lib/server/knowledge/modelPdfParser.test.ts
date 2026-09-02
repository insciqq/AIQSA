import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  finalizeParsedDocument,
  parsedLanguageHints
} from "../parsing/assessment";
import {
  modelPdfPageEndMarker,
  modelPdfPageStartMarker
} from "../parsing/modelPdfOutput";
import type { NativePdfGeometry } from "../parsing/nativePdf";
import { ProviderRequestTimeoutError } from "../providers/network";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { KnowledgeModelPdfAttemptError } from "./modelPdfAttemptRepository";
import {
  createKnowledgeModelPdfParser,
  KNOWLEDGE_MODEL_PDF_PROVIDER_ATTEMPT_TIMEOUT_MS,
  KNOWLEDGE_MODEL_PDF_PROVIDER_MAX_ATTEMPTS,
  KNOWLEDGE_MODEL_PDF_VISION_PAGE_CONCURRENCY
} from "./modelPdfParser";
import { KNOWLEDGE_PDF_PARSER_PROFILE_VERSION } from "./knowledgeProfile";

function snapshot(defaultParams: Record<string, unknown> = {}): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://api.openai.com/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "OpenAI",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: true,
        nativeSearch: false,
        pdf: true,
        reasoning: false,
        streaming: true,
        vision: true
      },
      defaultParams,
      modelClass: "answer",
      upstreamModelId: "gpt-test"
    },
    modelDisplayName: "GPT Test",
    providerFamily: "openai",
    providerModelId: "deployment-1",
    version: 1
  };
}

function output(): string {
  return [
    modelPdfPageStartMarker(1),
    "Metric\tValue",
    "Widget\t42",
    modelPdfPageEndMarker(1),
    modelPdfPageStartMarker(2),
    "Batch\t84",
    modelPdfPageEndMarker(2)
  ].join("\n");
}

function collaborationGeometry(): NativePdfGeometry {
  const rows = [
    { bottom: 700, text: "Visible heading", top: 718 },
    { bottom: 660, text: "Signed on 12.05.2024", top: 678 },
    { bottom: 620, text: "Recorded result 42", top: 638 }
  ];
  const blocks = rows.map((row, index) => ({
    assetIds: [],
    boundingBoxes: [{
      bottom: row.bottom,
      coordinateOrigin: "bottom_left" as const,
      left: 24,
      page: 1,
      right: 420,
      top: row.top
    }],
    headingPath: [],
    index,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text: row.text,
    type: "paragraph" as const
  }));
  return {
    blocks,
    classification: "native_text",
    pageCount: 1,
    quality: {
      pages: [{
        characterCount: rows.reduce((total, row) => total + row.text.length, 0),
        classification: "native_text",
        duplicateTextItemCount: 0,
        imageCount: 0,
        invalidCharacterCount: 0,
        invisibleText: false,
        maxVisualGroupCount: 1,
        multiGroupRowCount: 0,
        outOfBoundsTextItemCount: 0,
        overlappingTextItemCount: 0,
        page: 1,
        pageBottom: 0,
        pageLeft: 0,
        pageRight: 600,
        pageRotation: 0,
        pageTop: 800,
        rowCount: rows.length,
        rotatedTextItemCount: 0,
        shortRowCount: 0,
        textAreaRatio: 0.04,
        textItemCount: rows.length,
        vectorGraphicsOperationCount: 0,
        visualGroupOverflow: false
      }],
      visualGroupOverflow: false
    }
  };
}

function adaptiveGeometry(visionPage: number | null): NativePdfGeometry {
  const texts = [
    "Exact native page one with sufficient searchable text.",
    "Exact native page two with sufficient searchable text.",
    "Exact native page three with sufficient searchable text."
  ];
  const blocks = texts.map((value, index) => ({
    assetIds: [],
    boundingBoxes: [{
      bottom: 680,
      coordinateOrigin: "bottom_left" as const,
      left: 40,
      page: index + 1,
      right: 460,
      top: 700
    }],
    headingPath: [],
    index,
    isTable: false,
    languageHints: parsedLanguageHints(value),
    page: index + 1,
    pageEnd: index + 1,
    readingOrder: index,
    table: null,
    text: value,
    type: "paragraph" as const
  }));
  return {
    blocks,
    classification: "native_text",
    pageCount: 3,
    quality: {
      pages: texts.map((value, index) => ({
        characterCount: value.length,
        classification: "native_text" as const,
        duplicateTextItemCount: 0,
        imageCount: visionPage === index + 1 ? 1 : 0,
        invalidCharacterCount: 0,
        invisibleText: false,
        maxVisualGroupCount: 1,
        multiGroupRowCount: 0,
        outOfBoundsTextItemCount: 0,
        overlappingTextItemCount: 0,
        page: index + 1,
        pageBottom: 0,
        pageLeft: 0,
        pageRight: 600,
        pageRotation: 0,
        pageTop: 800,
        rotatedTextItemCount: 0,
        rowCount: 1,
        shortRowCount: 0,
        textAreaRatio: 0.02,
        textItemCount: 1,
        vectorGraphicsOperationCount: 0,
        visualGroupOverflow: false
      })),
      visualGroupOverflow: false
    }
  };
}

function adaptiveDocling(geometry: NativePdfGeometry) {
  return finalizeParsedDocument({
    attempts: [{ engine: "docling", errorCode: null, outcome: "complete" }],
    blocks: geometry.blocks,
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: geometry.pageCount,
    status: "complete"
  });
}

describe("Knowledge System Model PDF parser", () => {
  it("skips proven native pages and calls Vision only for the suspicious source page", async () => {
    const geometry = adaptiveGeometry(2);
    const reserve = vi.fn(async (input: Record<string, unknown>) => ({
      attemptId: `attempt-${input.batchIndex}`,
      kind: "dispatch" as const
    }));
    const settle = vi.fn(async (input: Record<string, unknown>) => ({
      artifactId: input.artifactId as string,
      attemptId: input.attemptId as string,
      batchIndex: input.batchIndex as number,
      mode: input.mode as "system_model_vision",
      pageEnd: input.pageEnd as number,
      pageStart: input.pageStart as number,
      requestDigest: input.requestDigest as string,
      resultText: input.resultText as string,
      sourceVersionId: input.sourceVersionId as string,
      usage: input.usage as never
    }));
    const prepare = vi.fn(async (input) => ({
      images: [{
        bytes: Buffer.from(`page-${input.pageStart}`),
        height: 3_200,
        mimeType: "image/png" as const,
        page: input.pageStart,
        sourceHeight: 800,
        sourceWidth: 600,
        width: 2_400
      }],
      kind: "images" as const,
      pageEnd: input.pageEnd,
      pageStart: input.pageStart
    }));
    const execute = vi.fn(async (_snapshot, request) => {
      expect(request.attachments).toHaveLength(1);
      expect(request.attachments[0]?.metadata).toEqual({
        image: expect.objectContaining({ sourcePage: 2 })
      });
      expect(request.content.blocks[0]).toMatchObject({
        text: expect.stringContaining("ADAPTIVE PAGE EVIDENCE")
      });
      expect(request.content.blocks[0]).toMatchObject({
        text: expect.stringContaining("Exact native page two")
      });
      return {
        finalProviderResponsePreview: {},
        finalText: [
          modelPdfPageStartMarker(2),
          "Exact native page two with sufficient searchable text.",
          modelPdfPageEndMarker(2)
        ].join("\n"),
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
      };
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(async () => undefined),
        markDispatched: vi.fn(async () => true),
        reserve,
        settle
      } as never,
      execute: execute as never,
      extractGeometry: vi.fn(async () => geometry),
      inspect: vi.fn(async () => ({ pageCount: 3 })),
      parseDocling: vi.fn(async () => adaptiveDocling(geometry)),
      prepare
    });

    const document = await parser.parse({
      artifactId: "artifact-adaptive-mixed",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-adaptive-mixed",
      sourceVersionId: "source-adaptive-mixed",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      pageEnd: 2,
      pageStart: 2
    }), expect.anything());
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ batchIndex: 1 }));
    expect(execute).toHaveBeenCalledOnce();
    expect(document.blocks.map(({ page, text }) => [page, text])).toEqual([
      [1, "Exact native page one with sufficient searchable text."],
      [2, "Exact native page two with sufficient searchable text."],
      [3, "Exact native page three with sufficient searchable text."]
    ]);
    expect(document.attempts.map(({ engine }) => engine)).toEqual([
      "native_pdf",
      "docling",
      "system_model_vision"
    ]);
  });

  it("uses zero provider calls when every page proves the native-only whitelist", async () => {
    const geometry = adaptiveGeometry(null);
    const execute = vi.fn();
    const reserve = vi.fn();
    const prepare = vi.fn();
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(),
        markDispatched: vi.fn(),
        reserve,
        settle: vi.fn()
      } as never,
      execute: execute as never,
      extractGeometry: vi.fn(async () => geometry),
      inspect: vi.fn(async () => ({ pageCount: 3 })),
      parseDocling: vi.fn(async () => adaptiveDocling(geometry)),
      prepare
    });

    const document = await parser.parse({
      artifactId: "artifact-adaptive-native",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-adaptive-native",
      sourceVersionId: "source-adaptive-native",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(document.engine).toBe("native_pdf");
    expect(document.blocks).toHaveLength(3);
  });

  it("dispatches one bounded request and turns the authoritative response into tables", async () => {
    const reserve = vi.fn(async () => ({ attemptId: "attempt-1", kind: "dispatch" as const }));
    const markDispatched = vi.fn(async () => true);
    const markAmbiguous = vi.fn(async () => undefined);
    const settle = vi.fn(async (input: Record<string, unknown>) => ({
      artifactId: input.artifactId as string,
      attemptId: "attempt-1",
      batchIndex: input.batchIndex as number,
      mode: input.mode as "system_model_direct_pdf",
      pageEnd: input.pageEnd as number,
      pageStart: input.pageStart as number,
      requestDigest: input.requestDigest as string,
      resultText: input.resultText as string,
      sourceVersionId: input.sourceVersionId as string,
      usage: input.usage as never
    }));
    const execute = vi.fn(async (_snapshot, request) => {
      expect(request.attachments).toHaveLength(1);
      expect(request.attachments[0]).toMatchObject({
        fileName: "pages-000001-000002.pdf",
        kind: "pdf",
        mimeType: "application/pdf"
      });
      expect(request.content.blocks).toEqual([
        expect.objectContaining({ text: expect.stringContaining(modelPdfPageStartMarker(1)) })
      ]);
      return {
        finalProviderResponsePreview: {},
        finalText: output(),
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
      };
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: { markAmbiguous, markDispatched, reserve, settle } as never,
      execute: execute as never,
      inspect: vi.fn(async () => ({ pageCount: 2 })),
      now: () => new Date("2026-08-23T16:00:00.000Z"),
      prepare: vi.fn(async (input) => ({
        bytes: Buffer.from("%PDF-bounded-range"),
        kind: "pdf" as const,
        pageEnd: input.pageEnd,
        pageStart: input.pageStart
      }))
    });

    const document = await parser.parse({
      artifactId: "artifact-1",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_direct_pdf",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-1",
      sourceVersionId: "source-version-1",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(document.engine).toBe("system_model_direct_pdf");
    expect(document.blocks.every(({ isTable }) => isTable)).toBe(true);
    expect(reserve).toHaveBeenCalledOnce();
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(markAmbiguous).not.toHaveBeenCalled();
  });

  it("uses one original-detail image request per page for the current Vision profile", async () => {
    const reserve = vi.fn(async (input: Record<string, unknown>) => ({
      attemptId: `attempt-${input.batchIndex}`,
      kind: "dispatch" as const
    }));
    const settle = vi.fn(async (input: Record<string, unknown>) => ({
      artifactId: input.artifactId as string,
      attemptId: input.attemptId as string,
      batchIndex: input.batchIndex as number,
      mode: input.mode as "system_model_vision",
      pageEnd: input.pageEnd as number,
      pageStart: input.pageStart as number,
      requestDigest: input.requestDigest as string,
      resultText: input.resultText as string,
      sourceVersionId: input.sourceVersionId as string,
      usage: input.usage as never
    }));
    const execute = vi.fn(async (_snapshot, request) => {
      expect(request.content.blocks[0]).toMatchObject({
        text: expect.stringContaining("Start the record with exactly `Visual data:`"),
        type: "text"
      });
      const metadata = request.attachments[0]!.metadata as {
        image: { sourcePage: number };
      };
      const page = metadata.image.sourcePage;
      expect(request.params.reasoning).toEqual({ effort: "medium", summary: "auto" });
      return {
        finalProviderResponsePreview: {},
        finalText: [
          modelPdfPageStartMarker(page),
          `Metric\tValue ${page}`,
          modelPdfPageEndMarker(page)
        ].join("\n"),
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
      };
    });
    const prepare = vi.fn(async (input, options) => {
      expect(options.visionQuality).toBe("adaptive_high_fidelity");
      expect(input.pageEnd).toBe(input.pageStart);
      const mimeType = input.pageStart === 1 ? "image/png" as const : "image/jpeg" as const;
      return {
        images: [{
          bytes: Buffer.from(`${mimeType}-page`),
          height: 3_200,
          mimeType,
          page: input.pageStart,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 2_400
        }],
        kind: "images" as const,
        pageEnd: input.pageEnd,
        pageStart: input.pageStart
      };
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(async () => undefined),
        markDispatched: vi.fn(async () => true),
        reserve,
        settle
      } as never,
      execute: execute as never,
      inspect: vi.fn(async () => ({ pageCount: 2 })),
      prepare: prepare as never
    });

    const document = await parser.parse({
      artifactId: "artifact-vision",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-vision",
      sourceVersionId: "source-version-vision",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot({ reasoning: { effort: "medium", summary: "auto" } })
    });

    expect(document.engine).toBe("system_model_vision");
    expect(document.pageCount).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(2);
    for (const [callIndex, call] of execute.mock.calls.entries()) {
      const request = call[1];
      const page = callIndex + 1;
      const expectedMimeType = page === 1 ? "image/png" : "image/jpeg";
      expect(request.attachments).toHaveLength(1);
      expect(request.attachments[0]).toMatchObject({
        dataUrl: expect.stringMatching(`^data:${expectedMimeType};base64,`),
        fileName: `page-${String(page).padStart(6, "0")}.${
          page === 1 ? "png" : "jpg"
        }`,
        metadata: {
          image: { detail: "original", sourcePage: page }
        },
        mimeType: expectedMimeType
      });
      expect(request.content.blocks).toEqual([
        expect.objectContaining({ text: expect.stringContaining(modelPdfPageStartMarker(page)) })
      ]);
      expect((request.content.blocks[0] as { text: string }).text).not.toContain(
        modelPdfPageStartMarker(page === 1 ? 2 : 1)
      );
      expect((request.content.blocks[0] as { text: string }).text).toContain(
        "original-detail page image"
      );
    }
  });

  it("keeps profile 13 on the immutable text-only Vision prompt", async () => {
    let prompt = "";
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(async () => undefined),
        markDispatched: vi.fn(async () => true),
        reserve: vi.fn(async () => ({ attemptId: "attempt-1", kind: "dispatch" as const })),
        settle: vi.fn(async (input: Record<string, unknown>) => ({
          artifactId: input.artifactId as string,
          attemptId: input.attemptId as string,
          batchIndex: input.batchIndex as number,
          mode: input.mode as "system_model_vision",
          pageEnd: input.pageEnd as number,
          pageStart: input.pageStart as number,
          processingGeneration: input.processingGeneration as number,
          requestDigest: input.requestDigest as string,
          resultText: input.resultText as string,
          sourceVersionId: input.sourceVersionId as string,
          usage: input.usage as never
        }))
      } as never,
      execute: vi.fn(async (_snapshot, request) => {
        prompt = (request.content.blocks[0] as { text: string }).text;
        return {
          finalProviderResponsePreview: {},
          finalText: [
            modelPdfPageStartMarker(1),
            "Historical transcription",
            modelPdfPageEndMarker(1)
          ].join("\n"),
          usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
        };
      }) as never,
      inspect: vi.fn(async () => ({ pageCount: 1 })),
      prepare: vi.fn(async () => ({
        images: [{
          bytes: Buffer.from("image-page"),
          height: 3_200,
          mimeType: "image/png" as const,
          page: 1,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 2_400
        }],
        kind: "images" as const,
        pageEnd: 1,
        pageStart: 1
      }))
    });

    await parser.parse({
      artifactId: "artifact-vision-v13",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: 13,
      processingGeneration: 0,
      profileRevisionId: "profile-vision-v13",
      sourceVersionId: "source-version-vision-v13",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(prompt).toContain("Do not summarize, interpret, correct, calculate, or omit content.");
    expect(prompt).not.toContain("Visual data:");
  });

  it("bounds concurrent Vision pages and restores source page order", async () => {
    let active = 0;
    let maximumActive = 0;
    const reserve = vi.fn(async (input: Record<string, unknown>) => ({
      attemptId: `attempt-${input.batchIndex}`,
      kind: "dispatch" as const
    }));
    const settle = vi.fn(async (input: Record<string, unknown>) => ({
      artifactId: input.artifactId as string,
      attemptId: input.attemptId as string,
      batchIndex: input.batchIndex as number,
      mode: input.mode as "system_model_vision",
      pageEnd: input.pageEnd as number,
      pageStart: input.pageStart as number,
      requestDigest: input.requestDigest as string,
      resultText: input.resultText as string,
      sourceVersionId: input.sourceVersionId as string,
      usage: input.usage as never
    }));
    const execute = vi.fn(async (_snapshot, request) => {
      const metadata = request.attachments[0]!.metadata as {
        image: { sourcePage: number };
      };
      const page = metadata.image.sourcePage;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(
        resolve,
        page % 2 === 0 ? 2 : 12
      ));
      active -= 1;
      return {
        finalProviderResponsePreview: {},
        finalText: [
          modelPdfPageStartMarker(page),
          `Page ${page}`,
          modelPdfPageEndMarker(page)
        ].join("\n"),
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
      };
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(async () => undefined),
        markDispatched: vi.fn(async () => true),
        reserve,
        settle
      } as never,
      execute: execute as never,
      inspect: vi.fn(async () => ({ pageCount: 4 })),
      prepare: vi.fn(async (input) => ({
        images: [{
          bytes: Buffer.from(`page-${input.pageStart}`),
          height: 3_200,
          mimeType: "image/png" as const,
          page: input.pageStart,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 2_400
        }],
        kind: "images" as const,
        pageEnd: input.pageEnd,
        pageStart: input.pageStart
      }))
    });

    const document = await parser.parse({
      artifactId: "artifact-parallel-vision",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-parallel-vision",
      sourceVersionId: "source-version-parallel-vision",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(KNOWLEDGE_MODEL_PDF_VISION_PAGE_CONCURRENCY).toBe(4);
    expect(maximumActive).toBe(KNOWLEDGE_MODEL_PDF_VISION_PAGE_CONCURRENCY);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(settle).toHaveBeenCalledTimes(4);
    expect(document.blocks.map(({ text }) => text)).toEqual([
      "Page 1",
      "Page 2",
      "Page 3",
      "Page 4"
    ]);
  });

  it("retries a page timeout and invalid output without repeating a settled sibling", async () => {
    const callsByPage = new Map<number, number>();
    const markAmbiguous = vi.fn(async () => undefined);
    const settle = vi.fn(async (input: Record<string, unknown>) => ({
      artifactId: input.artifactId as string,
      attemptId: input.attemptId as string,
      batchIndex: input.batchIndex as number,
      mode: input.mode as "system_model_vision",
      pageEnd: input.pageEnd as number,
      pageStart: input.pageStart as number,
      requestDigest: input.requestDigest as string,
      resultText: input.resultText as string,
      sourceVersionId: input.sourceVersionId as string,
      usage: input.usage as never
    }));
    const execute = vi.fn(async (_snapshot, request, options) => {
      expect(options.timeoutMs).toBe(KNOWLEDGE_MODEL_PDF_PROVIDER_ATTEMPT_TIMEOUT_MS);
      const metadata = request.attachments[0]!.metadata as {
        image: { sourcePage: number };
      };
      const page = metadata.image.sourcePage;
      const attempt = (callsByPage.get(page) ?? 0) + 1;
      callsByPage.set(page, attempt);
      if (page === 2 && attempt === 1) {
        throw new ProviderRequestTimeoutError(KNOWLEDGE_MODEL_PDF_PROVIDER_ATTEMPT_TIMEOUT_MS);
      }
      if (page === 2 && attempt === 2) {
        return {
          finalProviderResponsePreview: {},
          finalText: "invalid page envelope",
          usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
        };
      }
      return {
        finalProviderResponsePreview: {},
        finalText: [
          modelPdfPageStartMarker(page),
          `Page ${page}`,
          modelPdfPageEndMarker(page)
        ].join("\n"),
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
      };
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous,
        markDispatched: vi.fn(async () => true),
        reserve: vi.fn(async (input: Record<string, unknown>) => ({
          attemptId: `attempt-${input.batchIndex}`,
          kind: "dispatch" as const
        })),
        settle
      } as never,
      execute: execute as never,
      inspect: vi.fn(async () => ({ pageCount: 2 })),
      prepare: vi.fn(async (input) => ({
        images: [{
          bytes: Buffer.from(`page-${input.pageStart}`),
          height: 3_200,
          mimeType: "image/png" as const,
          page: input.pageStart,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 2_400
        }],
        kind: "images" as const,
        pageEnd: input.pageEnd,
        pageStart: input.pageStart
      })),
      retry: {
        random: () => 0,
        sleep: async () => undefined
      }
    });

    const document = await parser.parse({
      artifactId: "artifact-retry-vision",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: KNOWLEDGE_PDF_PARSER_PROFILE_VERSION,
      processingGeneration: 0,
      profileRevisionId: "profile-retry-vision",
      sourceVersionId: "source-version-retry-vision",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    });

    expect(KNOWLEDGE_MODEL_PDF_PROVIDER_MAX_ATTEMPTS).toBe(3);
    expect(callsByPage).toEqual(new Map([[1, 1], [2, 3]]));
    expect(markAmbiguous).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls.find(([input]) => input.batchIndex === 1)?.[0].usage)
      .toMatchObject({ inputTokens: 200, outputTokens: 40, totalTokens: 240 });
    expect(document.blocks.map(({ text }) => text)).toEqual(["Page 1", "Page 2"]);
  });

  it("keeps gap filling in profile 10 and adds bounded native corrections in profile 11", async () => {
    const parseAtProfile = async (parserProfileVersion: number) => {
      const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
        attemptRepository: {
          markAmbiguous: vi.fn(async () => undefined),
          markDispatched: vi.fn(async () => true),
          reserve: vi.fn(async () => ({ attemptId: "attempt-1", kind: "dispatch" as const })),
          settle: vi.fn(async (input: Record<string, unknown>) => ({
            artifactId: input.artifactId as string,
            attemptId: input.attemptId as string,
            batchIndex: input.batchIndex as number,
            mode: input.mode as "system_model_vision",
            pageEnd: input.pageEnd as number,
            pageStart: input.pageStart as number,
            requestDigest: input.requestDigest as string,
            resultText: input.resultText as string,
            sourceVersionId: input.sourceVersionId as string,
            usage: input.usage as never
          }))
        } as never,
        execute: vi.fn(async () => ({
          finalProviderResponsePreview: {},
          finalText: [
            modelPdfPageStartMarker(1),
            "Visible heading",
            "Recorded result 41",
            modelPdfPageEndMarker(1)
          ].join("\n"),
          usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 }
        })) as never,
        extractGeometry: vi.fn(async () => collaborationGeometry()),
        inspect: vi.fn(async () => ({ pageCount: 1 })),
        prepare: vi.fn(async () => ({
          images: [{
            bytes: Buffer.from("image-page"),
            height: 3_200,
            mimeType: "image/png" as const,
            page: 1,
            sourceHeight: 800,
            sourceWidth: 600,
            width: 2_400
          }],
          kind: "images" as const,
          pageEnd: 1,
          pageStart: 1
        }))
      });
      return parser.parse({
        artifactId: `artifact-${parserProfileVersion}`,
        bytes: Buffer.from("%PDF-source"),
        maxBlocks: 100,
        maxCharacters: 10_000,
        maxPages: 10,
        mode: "system_model_vision",
        ownerUserId: "owner-1",
        parserProfileVersion,
        processingGeneration: 0,
        profileRevisionId: `profile-${parserProfileVersion}`,
        sourceVersionId: `source-version-${parserProfileVersion}`,
        systemModelPolicyVersion: 3,
        systemModelSnapshot: snapshot()
      });
    };

    const legacy = await parseAtProfile(9);
    const gapFillOnly = await parseAtProfile(10);
    const current = await parseAtProfile(KNOWLEDGE_PDF_PARSER_PROFILE_VERSION);

    expect(legacy.blocks.map(({ text }) => text)).toEqual([
      "Visible heading",
      "Recorded result 41"
    ]);
    expect(legacy.attempts).not.toContainEqual(expect.objectContaining({ engine: "native_pdf" }));
    expect(gapFillOnly.blocks.map(({ text }) => text)).toEqual([
      "Visible heading",
      "Signed on 12.05.2024",
      "Recorded result 41"
    ]);
    expect(current.blocks.map(({ text }) => text)).toEqual([
      "Visible heading",
      "Signed on 12.05.2024",
      "Recorded result 42"
    ]);
    expect(current.attempts).toContainEqual({
      engine: "native_pdf",
      errorCode: null,
      outcome: "complete"
    });
  });

  it("preserves the non-adaptive renderer for recoverable profile-v3 attempts", async () => {
    const prepare = vi.fn(async (_input, options) => {
      expect(options.visionQuality).toBe("high_fidelity");
      throw new Error("stop_after_profile_assertion");
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {} as never,
      execute: vi.fn() as never,
      inspect: vi.fn(async () => ({ pageCount: 1 })),
      prepare: prepare as never
    });

    await expect(parser.parse({
      artifactId: "artifact-vision-v3",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: 3,
      processingGeneration: 0,
      profileRevisionId: "profile-vision-v3",
      sourceVersionId: "source-version-vision-v3",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    })).rejects.toMatchObject({ code: "pdf_processing_failed" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("preserves the single adaptive overview for recoverable profile-v4 attempts", async () => {
    const prepare = vi.fn(async (_input, options) => {
      expect(options.visionQuality).toBe("adaptive_high_fidelity");
      throw new Error("stop_after_profile_assertion");
    });
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {} as never,
      execute: vi.fn() as never,
      inspect: vi.fn(async () => ({ pageCount: 1 })),
      prepare: prepare as never
    });

    await expect(parser.parse({
      artifactId: "artifact-vision-v4",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_vision",
      ownerUserId: "owner-1",
      parserProfileVersion: 4,
      processingGeneration: 0,
      profileRevisionId: "profile-vision-v4",
      sourceVersionId: "source-version-vision-v4",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    })).rejects.toMatchObject({ code: "pdf_processing_failed" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("never repeats a dispatched attempt whose outcome is unknown", async () => {
    const execute = vi.fn();
    const parser = createKnowledgeModelPdfParser({} as PrismaClient, {
      attemptRepository: {
        markAmbiguous: vi.fn(),
        markDispatched: vi.fn(),
        reserve: vi.fn(async () => {
          throw new KnowledgeModelPdfAttemptError("pdf_processing_ambiguous");
        }),
        settle: vi.fn()
      } as never,
      execute: execute as never,
      inspect: vi.fn(async () => ({ pageCount: 1 })),
      prepare: vi.fn(async () => ({
        bytes: Buffer.from("%PDF-bounded-range"),
        kind: "pdf" as const,
        pageEnd: 1,
        pageStart: 1
      }))
    });

    await expect(parser.parse({
      artifactId: "artifact-1",
      bytes: Buffer.from("%PDF-source"),
      maxBlocks: 100,
      maxCharacters: 10_000,
      maxPages: 10,
      mode: "system_model_direct_pdf",
      ownerUserId: "owner-1",
      parserProfileVersion: 1,
      processingGeneration: 0,
      profileRevisionId: "profile-1",
      sourceVersionId: "source-version-1",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    })).rejects.toMatchObject({ code: "pdf_processing_ambiguous" });
    expect(execute).not.toHaveBeenCalled();
  });
});
