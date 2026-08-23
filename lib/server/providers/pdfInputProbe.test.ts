import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderRunResult } from "./types";
import {
  createProviderPdfInputProbe,
  imageOnlyPdfInputProbeFixture,
  PDF_INPUT_PROBE_CODE,
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

const expectedProbeCodeGlyphs = {
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "11100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"]
} as const;

function expectProbeCodeInRaster(raster: Buffer): void {
  [...PDF_INPUT_PROBE_CODE].forEach((character, characterIndex) => {
    const glyph = expectedProbeCodeGlyphs[character as keyof typeof expectedProbeCodeGlyphs];
    expect(glyph, `missing independent test glyph for ${character}`).toBeDefined();
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        const x = 274 + (characterIndex * 6 + columnIndex) * 4 + 2;
        const y = 154 + rowIndex * 4 + 2;
        expect(raster[y * PDF_INPUT_PROBE_WIDTH + x]).toBe(pixel === "1" ? 0 : 255);
      });
    });
  });
}

describe("direct PDF input probe", () => {
  it("builds a small image-only PDF whose raster contains the expected code", () => {
    const fixture = imageOnlyPdfInputProbeFixture();
    expect(fixture.mimeType).toBe(PDF_INPUT_PROBE_MIME_TYPE);
    expect(fixture.bytes.length).toBeGreaterThan(0);
    expect(fixture.bytes.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    expect(fixture.bytes.includes(Buffer.from(PDF_INPUT_PROBE_CODE, "ascii"))).toBe(false);
    expect(fixture.bytes.toString("latin1")).toContain("/Subtype /Image");
    expect(fixture.bytes.toString("latin1")).not.toContain("/Font");
    expect(fixture.bytes.toString("latin1")).toContain(
      `${PDF_INPUT_PROBE_WIDTH} 0 0 ${PDF_INPUT_PROBE_HEIGHT} 0 0 cm`
    );
    expect(fixture.bytes.toString("latin1")).not.toContain(
      `0 -${PDF_INPUT_PROBE_HEIGHT}`
    );

    const raster = compressedRaster(fixture.bytes);
    expect(raster).toHaveLength(PDF_INPUT_PROBE_WIDTH * PDF_INPUT_PROBE_HEIGHT);
    expectProbeCodeInRaster(raster);
    const bottomRightInk = Array.from(raster).filter((value, index) => {
      const x = index % PDF_INPUT_PROBE_WIDTH;
      const y = Math.floor(index / PDF_INPUT_PROBE_WIDTH);
      return x >= 274 && y >= 154 && value === 0;
    }).length;
    expect(bottomRightInk).toBeGreaterThan(300);
  });

  it("uses an original PDF block with every optional feature disabled", async () => {
    const requests: unknown[] = [];
    const probe = createProviderPdfInputProbe({
      createAdapter: () => adapter(PDF_INPUT_PROBE_CODE, requests)
    });

    await expect(probe.probe(input())).resolves.toEqual({
      adapterKind: "openai_responses_native",
      probeVersion: 1,
      upstreamModelId: "model-pdf",
      verified: true
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      attachments: [{
        base64Data: expect.any(String),
        extractedText: null,
        kind: "pdf",
        mimeType: "application/pdf"
      }],
      forceNonStreaming: true,
      knowledgePlan: { mode: "none" },
      params: { background: false, store: false, stream: false },
      searchPlan: { options: [] },
      toolChoice: "none",
      toolMode: "none",
      tools: []
    });
  });

  it.each([
    [PDF_INPUT_PROBE_CODE, true],
    [` ${PDF_INPUT_PROBE_CODE}\n`, true],
    [`The code is ${PDF_INPUT_PROBE_CODE}`, false],
    ["```\nQ7K4P9\n```", false],
    ["", false]
  ])("accepts only exact trimmed final text %#", async (output, verified) => {
    const probe = createProviderPdfInputProbe({
      createAdapter: () => adapter(output, [])
    });
    const result = await probe.probe(input());
    expect(Boolean(result)).toBe(verified);
  });

  it("rejects reasoning artifacts without visible final text", async () => {
    const probe = createProviderPdfInputProbe({
      createAdapter: () => ({
        async *stream() {
          yield {
            data: { artifactType: "reasoning", payload: { reasoning: PDF_INPUT_PROBE_CODE } },
            type: "artifact" as const
          };
          return terminal("");
        }
      })
    });

    await expect(probe.probe(input())).resolves.toBeNull();
  });

  it("discovers PDF support without a declared flag and skips unsupported adapters", async () => {
    const createAdapter = vi.fn(() => adapter(PDF_INPUT_PROBE_CODE, []));
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
