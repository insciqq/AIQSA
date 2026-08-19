import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { createAcceptedKnowledgeVisionRuntime } from "./visualRuntime";

function role(nativePdfInput = false): ProviderAdmissionRole {
  const capabilities = {
    nativePdfInput,
    nativeSearch: false,
    pdf: nativePdfInput,
    reasoning: false,
    streaming: false,
    vision: true
  };
  return {
    authority: {
      connectionId: "connection-1",
      connectionVersion: 2,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      modelVersion: 3,
      providerModelId: "vision-model-1"
    },
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_chat_completions_compatible",
      capabilities,
      defaultParams: { maxOutputTokens: 10_000 }
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Local vision",
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_chat_completions_compatible",
        answerSelectable: true,
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "vision-upstream-1"
      },
      modelDisplayName: "Vision",
      providerFamily: "openai_compatible",
      providerModelId: "vision-model-1",
      version: 1
    }
  };
}

describe("accepted Knowledge vision runtime", () => {
  it("locks the exact installation credential and sends a generic bounded image request", async () => {
    const queryRaw = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: null,
      secretEnvelope: null,
      testEvidence: { authenticationMode: "none" }
    }]);
    const client = {
      $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
        consume({ $queryRaw: queryRaw }))
    } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        max_completion_tokens: 1_024,
        model: "vision-upstream-1",
        stream: false
      });
      expect(String(init?.body)).toContain("data:image/png;base64,UE5H");
      expect(String(init?.body)).not.toContain("private-report-name");
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          index: 0,
          message: { content: "The bar rises from left to right.", role: "assistant" }
        }],
        id: "chatcmpl-visual-1",
        model: "vision-upstream-1",
        usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 }
      }));
    });
    const loadRole = vi.fn(async () => role());
    const runtime = createAcceptedKnowledgeVisionRuntime(client as never, {
      createFetch: () => fetchFn,
      loadRole
    });

    await expect(runtime.analyze({
      bytes: Buffer.from("PNG", "utf8"),
      mimeType: "image/png",
      profileRevisionId: "profile-revision-1",
      prompt: "Analyze target page 2.",
      providerModelId: "vision-model-1"
    })).resolves.toMatchObject({
      description: "The bar rises from left to right.",
      modelId: "vision-upstream-1",
      provider: "openai_compatible",
      providerModelId: "vision-model-1",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 }
    });
    expect(loadRole).toHaveBeenCalledWith(client, "vision-model-1");
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("rejects PDF egress unless the exact pinned model supports native PDF input", async () => {
    const client = { $transaction: vi.fn() } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>();
    const runtime = createAcceptedKnowledgeVisionRuntime(client as never, {
      createFetch: () => fetchFn,
      loadRole: vi.fn(async () => role(false))
    });

    await expect(runtime.analyze({
      bytes: Buffer.from("%PDF", "utf8"),
      mimeType: "application/pdf",
      profileRevisionId: "profile-revision-1",
      prompt: "Analyze page 2.",
      providerModelId: "vision-model-1"
    })).rejects.toThrow("knowledge_visual_provider_unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
