import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  modelPdfPageEndMarker,
  modelPdfPageStartMarker
} from "../parsing/modelPdfOutput";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { KnowledgeModelPdfAttemptError } from "./modelPdfAttemptRepository";
import { createKnowledgeModelPdfParser } from "./modelPdfParser";
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

describe("Knowledge System Model PDF parser", () => {
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
        text: expect.stringContaining("[[AIQSA_ROW_CONTINUATION]]"),
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
      profileRevisionId: "profile-1",
      sourceVersionId: "source-version-1",
      systemModelPolicyVersion: 3,
      systemModelSnapshot: snapshot()
    })).rejects.toMatchObject({ code: "pdf_processing_ambiguous" });
    expect(execute).not.toHaveBeenCalled();
  });
});
