import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderRunResult } from "./types";
import {
  createProviderPdfInputProbe,
  imageOnlyPdfInputProbeFixture,
  PDF_INPUT_PROBE_ANSWER,
  PDF_INPUT_PROBE_HEIGHT,
  PDF_INPUT_PROBE_MIME_TYPE,
  PDF_INPUT_PROBE_WIDTH,
  type ProviderPdfInputProbeInput
} from "./pdfInputProbe";

function input(): ProviderPdfInputProbeInput {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "Provider",
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
        vision: true
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "model-pdf"
    },
    modelDisplayName: "Model PDF",
    providerFamily: "openai",
    providerModelId: "model-1",
    secret: "secret"
  };
}

function terminal(finalText: string): ProviderRunResult {
  return {
    finalProviderResponsePreview: {},
    finalText,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
  };
}

function adapter(finalText: string, requests: unknown[]): Pick<ProviderAdapter, "stream"> {
  return {
    async *stream(request) {
      requests.push(request);
      return terminal(finalText);
    }
  };
}

function compressedRaster(pdf: Buffer): Buffer {
  const marker = Buffer.from("/Filter /FlateDecode /Length ", "ascii");
  const markerIndex = pdf.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(0);
  const lengthStart = markerIndex + marker.length;
  const lengthEnd = pdf.indexOf(Buffer.from(" >>", "ascii"), lengthStart);
  const length = Number(pdf.subarray(lengthStart, lengthEnd).toString("ascii"));
  const streamStart = pdf.indexOf(Buffer.from("stream\n", "ascii"), lengthEnd) + 7;
  return inflateSync(pdf.subarray(streamStart, streamStart + length));
}

const expectedAnswerGlyphs = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"]
} as const;

function expectAnswerInRaster(raster: Buffer): void {
  [..."PEARS"].forEach((character, characterIndex) => {
    const glyph = expectedAnswerGlyphs[character as keyof typeof expectedAnswerGlyphs];
    expect(glyph, `missing independent test glyph for ${character}`).toBeDefined();
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        const x = 30 + (characterIndex * 6 + columnIndex) * 5 + 2;
        const y = 228 + rowIndex * 5 + 2;
        expect(raster[y * PDF_INPUT_PROBE_WIDTH + x]).toBe(pixel === "1" ? 0 : 255);
      });
    });
  });
}

describe("direct PDF input probe", () => {
  it("builds a pinned image-only receipt with the expected factual answer", () => {
    const fixture = imageOnlyPdfInputProbeFixture();
    expect(fixture.mimeType).toBe(PDF_INPUT_PROBE_MIME_TYPE);
    expect(fixture.bytes.length).toBeGreaterThan(0);
    expect(fixture.bytes.length).toBeLessThan(10_000);
    expect(createHash("sha256").update(fixture.bytes).digest("hex")).toBe("c12a255c8ccd4cd54aebf5bbf33086fd9c474f494f88be3f2c76e84f3e98bdcf");
    expect(fixture.bytes.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(fixture.bytes.includes(Buffer.from(PDF_INPUT_PROBE_ANSWER, "ascii"))).toBe(false);
    expect(fixture.bytes.toString("latin1")).toContain("/Subtype /Image");
    expect(fixture.bytes.toString("latin1")).not.toContain("/Font");
    expect(fixture.bytes.toString("latin1")).not.toContain("/Encrypt");
    expect(fixture.fileName).not.toContain(PDF_INPUT_PROBE_ANSWER);
    expect(fixture.bytes.toString("latin1")).toContain(
      `${PDF_INPUT_PROBE_WIDTH} 0 0 ${PDF_INPUT_PROBE_HEIGHT} 0 0 cm`
    );
    expect(fixture.bytes.toString("latin1")).not.toContain(
      `0 -${PDF_INPUT_PROBE_HEIGHT}`
    );

    const raster = compressedRaster(fixture.bytes);
    expect(raster).toHaveLength(PDF_INPUT_PROBE_WIDTH * PDF_INPUT_PROBE_HEIGHT);
    expectAnswerInRaster(raster);
  });

  it("uses an original PDF block with every optional feature disabled", async () => {
    const requests: unknown[] = [];
    const probe = createProviderPdfInputProbe({
      createAdapter: () => adapter(PDF_INPUT_PROBE_ANSWER, requests)
    });

    await expect(probe.probe(input())).resolves.toEqual({
      adapterKind: "openai_responses_native",
      probeVersion: 1,
      upstreamModelId: "model-pdf",
      verified: true
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify((requests[0] as { content: unknown }).content)).not.toContain(PDF_INPUT_PROBE_ANSWER);
    expect(requests[0]).toMatchObject({
      attachments: [{
        base64Data: expect.any(String),
        extractedText: null,
        kind: "pdf",
        mimeType: "application/pdf"
      }],
      forceNonStreaming: true,
      knowledgePlan: { mode: "none" },
      params: {
        background: false,
        maxOutputTokens: 512,
        maxTokens: 512,
        max_output_tokens: 512,
        store: false,
        stream: false
      },
      searchPlan: { options: [] },
      toolChoice: "none",
      toolMode: "none",
      tools: []
    });
  });

  it.each([
    [PDF_INPUT_PROBE_ANSWER, true],
    [` ${PDF_INPUT_PROBE_ANSWER}\n`, true],
    [`The item is ${PDF_INPUT_PROBE_ANSWER}`, false],
    ["```\nPEARS\n```", false],
    ["", false]
  ])("accepts only exact trimmed final text %#", async (output, verified) => {
    const probe = createProviderPdfInputProbe({
      createAdapter: () => adapter(output, [])
    });
    if (verified) await expect(probe.probe(input())).resolves.toMatchObject({ verified: true });
    else await expect(probe.probe(input())).rejects.toThrow("pdf_input_probe_inconclusive");
  });

  it("rejects reasoning artifacts without visible final text", async () => {
    const probe = createProviderPdfInputProbe({
      createAdapter: () => ({
        async *stream() {
          yield {
            data: { artifactType: "reasoning", payload: { reasoning: PDF_INPUT_PROBE_ANSWER } },
            type: "artifact" as const
          };
          return terminal("");
        }
      })
    });

    await expect(probe.probe(input())).rejects.toThrow("pdf_input_probe_inconclusive");
  });

  it.each(["length", "content_filter"])("does not verify the expected text from a %s terminal", async (finishReason) => {
    const probe = createProviderPdfInputProbe({ createAdapter: () => ({
      async *stream() {
        return { ...terminal(PDF_INPUT_PROBE_ANSWER), finalProviderResponsePreview: { finishReason } };
      }
    }) });
    await expect(probe.probe(input())).rejects.toThrow("pdf_input_probe_inconclusive");
  });

  it("discovers PDF support without a declared flag and skips unsupported adapters", async () => {
    const createAdapter = vi.fn(() => adapter(PDF_INPUT_PROBE_ANSWER, []));
    const probe = createProviderPdfInputProbe({ createAdapter });

    await expect(probe.probe({
      ...input(),
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, nativePdfInput: false }
      }
    })).resolves.toMatchObject({ verified: true });
    await expect(probe.probe({
      ...input(),
      model: { ...input().model, adapterKind: "openai_chat_completions_compatible" }
    })).resolves.toBeNull();
    expect(createAdapter).toHaveBeenCalledOnce();
  });
});
