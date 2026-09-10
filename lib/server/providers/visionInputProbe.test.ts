import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { assertVisionProbeImage } from "../../../scripts/vision-probe-image-oracle";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import { createProviderVisionInputProbe, VISION_INPUT_PROBE_ANSWER } from "./visionInputProbe";
import { receiptProbeRaster } from "./receiptProbeFixture";

function snapshot(vision = true): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Connection",
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
        vision
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "gpt-test"
    },
    modelDisplayName: "Model",
    providerFamily: "openai",
    providerModelId: "deployment-1",
    version: 1
  };
}

describe("Vision input probe", () => {
  it("uses one bounded image request and accepts only the exact receipt item", async () => {
    const execute = vi.fn(async (_snapshot, request, options) => {
      expect(request.attachments).toEqual([
        expect.objectContaining({
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
          kind: "image",
          mimeType: "image/png"
        })
      ]);
      const image = Buffer.from(request.attachments[0].dataUrl.split(",")[1], "base64");
      expect(image.byteLength).toBe(request.attachments[0].byteSize);
      await assertVisionProbeImage(image);
      expect(JSON.stringify({ ...request, attachments: request.attachments.map(({ dataUrl: _dataUrl, ...metadata }: { dataUrl: string }) => metadata) })).not.toContain(VISION_INPUT_PROBE_ANSWER);
      expect(request.attachments[0].extractedText).toBeNull();
      expect(JSON.stringify(request.content)).toContain("quantity of 7");
      expect(request.forceNonStreaming).toBe(true);
      expect(request.params).toMatchObject({
        maxOutputTokens: 512,
        maxTokens: 512,
        max_output_tokens: 512
      });
      expect(request.tools).toEqual([]);
      expect(options).toMatchObject({ timeoutMs: 120_000 });
      return {
        finalProviderResponsePreview: {},
        finalText: VISION_INPUT_PROBE_ANSWER,
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 }
      };
    });
    const probe = createProviderVisionInputProbe({ execute });

    await expect(probe.probe(snapshot())).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does no provider I/O for an undeclared Vision deployment", async () => {
    const execute = vi.fn();
    const probe = createProviderVisionInputProbe({ execute });

    await expect(probe.probe(snapshot(false))).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("sanitizes local rendering failures and retries the fixture on the next check", async () => {
    vi.resetModules();
    const fresh = await import("./visionInputProbe");
    const rendering = vi.spyOn(sharp.prototype, "toBuffer")
      .mockRejectedValueOnce(new Error("private renderer diagnostics"));
    const execute = vi.fn(async () => ({
      finalProviderResponsePreview: {}, finalText: VISION_INPUT_PROBE_ANSWER,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 }
    }));
    try {
      const probe = fresh.createProviderVisionInputProbe({ execute });
      await expect(probe.probe(snapshot())).rejects.toThrow(/^vision_input_fixture_unavailable$/u);
      expect(execute).not.toHaveBeenCalled();
      await expect(probe.probe(snapshot())).resolves.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      rendering.mockRestore();
    }
  });

  it.each(["", "APPLES", "The item is PEARS"])("rejects a non-exact answer %j", async (finalText) => {
    const execute = vi.fn(async () => ({
      finalProviderResponsePreview: {}, finalText,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 }
    }));
    await expect(createProviderVisionInputProbe({ execute }).probe(snapshot())).resolves.toBe(false);
  });

  it("rejects a blank receipt, incorrect item pixels and incorrect quantity pixels", async () => {
    const blank = new Uint8Array(480 * 360).fill(255);
    const wrongItem = receiptProbeRaster();
    wrongItem[228 * 480 + 30] = 255;
    const wrongQuantity = receiptProbeRaster();
    wrongQuantity[228 * 480 + 406] = 255;
    for (const raster of [blank, wrongItem, wrongQuantity]) {
      const image = await sharp(Buffer.from(raster), { raw: { width: 480, height: 360, channels: 1 } }).png().toBuffer();
      await expect(assertVisionProbeImage(image)).rejects.toThrow("vision_probe_receipt_pixels_invalid");
    }
  });
});
