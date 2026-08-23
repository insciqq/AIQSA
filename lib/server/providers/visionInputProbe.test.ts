import { describe, expect, it, vi } from "vitest";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import { createProviderVisionInputProbe, VISION_INPUT_PROBE_CODE } from "./visionInputProbe";

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
  it("uses one bounded image request and accepts only the exact fixture code", async () => {
    const execute = vi.fn(async (_snapshot, request, options) => {
      expect(request.attachments).toEqual([
        expect.objectContaining({
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
          kind: "image",
          mimeType: "image/png"
        })
      ]);
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
        finalText: VISION_INPUT_PROBE_CODE,
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
});
