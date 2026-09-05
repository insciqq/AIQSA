import { describe, expect, it, vi } from "vitest";
import type { OpenRouterDiscoveryClient } from "../../providers/openRouterDiscovery";
import {
  createAdminProviderDraftTester,
  type AdminProviderDraftTesterInput
} from "./tester";

function input(
  overrides: Partial<AdminProviderDraftTesterInput> = {}
): AdminProviderDraftTesterInput {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://openrouter.ai/api/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "OpenRouter",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionIdentity: "draft:1",
    mode: "account_catalog",
    model: {
      adapterKind: "openrouter_chat_completions",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      defaultParams: {},
      modelClass: "answer",
      openRouterRouting: { mode: "automatic", providers: [] },
      upstreamModelId: "vendor/model"
    },
    modelDisplayName: "Vendor Model",
    providerFamily: "openrouter",
    providerModelId: "model-1",
    secret: "secret",
    ...overrides
  };
}

function discovery(overrides: Partial<OpenRouterDiscoveryClient> = {}): OpenRouterDiscoveryClient {
  return {
    async listEmbeddingModels() { return []; },
    async listModelEndpoints() { return []; },
    async listRerankModels() { return []; },
    async listModels() {
      return [{
        id: "vendor/model",
        inputModalities: ["text"],
        name: "Vendor Model",
        outputModalities: ["text"],
        pricing: {},
        supportedParameters: []
      }];
    },
    ...overrides
  };
}

describe("image input compatibility", () => {
  it.each([true, false])("records only a real image probe success (%s)", async (success) => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (JSON.stringify(body.messages).includes("image_url")) return Response.json({
        choices: [{ finish_reason: "stop", message: {
          content: success ? "V4K8M2" : "WRONG", role: "assistant"
        } }],
        usage: { completion_tokens: 4, prompt_tokens: 10, total_tokens: 14 }
      });
      return body.stream ? streamedChatResponse() : structuredChatResponse();
    });
    const base = input();
    const outcome = await createAdminProviderDraftTester({ createFetch: () => fetchFn }).test({
      ...base,
      mode: "tiny_generation",
      model: { ...base.model, capabilities: { ...base.model.capabilities, vision: true } }
    });
    expect(outcome.status).toBe("available");
    expect(outcome.evidence.compatibility?.vision).toBe(success ? "verified" : "not_supported");
    expect(Boolean(outcome.evidence.visionInput)).toBe(success);
    const calls = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const vision = calls.filter((body) => JSON.stringify(body.messages).includes("image_url"));
    expect(vision).toHaveLength(1);
    expect(vision[0].stream).toBe(false);
    expect(vision[0].tools ?? []).toEqual([]);
  });
});

function structuredChatResponse(toolCall = false) {
  const result = {
    count: 2,
    label: "AIQSA",
    ready: true,
    tool_ids: ["alpha", "beta"]
  };
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: toolCall ? "tool_calls" : "stop",
      message: toolCall
        ? {
            content: null,
            role: "assistant",
            tool_calls: [{
              function: {
                arguments: JSON.stringify(result),
                name: "aiqsa_structured_output_probe"
              },
              id: "call-1",
              type: "function"
            }]
          }
        : { content: JSON.stringify(result), role: "assistant" }
    }],
    usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

function streamedChatResponse() {
  const body = [
    'data: {"id":"chat-1","model":"vendor/model","choices":[{"delta":{"content":"OK"},"finish_reason":null}]}',
    "",
    'data: {"id":"chat-1","model":"vendor/model","choices":[],"usage":{"completion_tokens":1,"prompt_tokens":2,"total_tokens":3}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200
  });
}

function strictToolChatResponse(
  name: string,
  args: Record<string, unknown>
) {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        role: "assistant",
        tool_calls: [{
          function: { arguments: JSON.stringify(args), name },
          id: "call-strict",
          type: "function"
        }]
      }
    }],
    usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

describe("admin provider draft tester", () => {
  it("verifies forced strict calls independently from an auto structured-output route", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream === true) return streamedChatResponse();
      const tools = body.tools as Array<{
        function?: { name?: string };
      }> | undefined;
      const name = tools?.[0]?.function?.name;
      if (name === "aiqsa_structured_output_probe") {
        return strictToolChatResponse(name, {
          count: 2,
          label: "AIQSA",
          ready: true,
          tool_ids: ["alpha", "beta"]
        });
      }
      if (name === "aiqsa_forced_tool_call_probe") {
        return strictToolChatResponse(name, { nonce: "aiqsa-control-ready" });
      }
      return structuredChatResponse();
    });
    const configured = input({
      mode: "tiny_generation",
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, toolCalling: true },
        defaultParams: {
          provider: { structuredOutputToolChoice: "auto" }
        }
      }
    });
    const providerTester = createAdminProviderDraftTester({
      createFetch: () => fetchFn
    });

    await expect(providerTester.test(configured)).resolves.toMatchObject({
      evidence: {
        compatibility: {
          forcedToolCall: "verified",
          structuredOutput: "verified"
        },
        forcedToolCall: {
          adapterKind: "openrouter_chat_completions",
          probeVersion: 1,
          upstreamModelId: "vendor/model",
          verified: true
        }
      },
      status: "available"
    });
    const structured = bodies.find((body) => {
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
      return tools?.[0]?.function?.name === "aiqsa_structured_output_probe";
    });
    const forced = bodies.find((body) => {
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
      return tools?.[0]?.function?.name === "aiqsa_forced_tool_call_probe";
    });
    expect(structured).toMatchObject({ tool_choice: "auto" });
    expect(forced).toMatchObject({
      provider: { require_parameters: true },
      tool_choice: "required",
      tools: [{ function: { strict: true }, type: "function" }]
    });
    expect(forced).not.toHaveProperty("parallel_tool_calls");
  });

  it("does not mint forced-call evidence when the selected route ignores it", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      if (body.stream === true) return streamedChatResponse();
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
      const name = tools?.[0]?.function?.name;
      return name === "aiqsa_structured_output_probe"
        ? strictToolChatResponse(name, {
            count: 2,
            label: "AIQSA",
            ready: true,
            tool_ids: ["alpha", "beta"]
          })
        : structuredChatResponse();
    });
    const configured = input({
      mode: "tiny_generation",
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, toolCalling: true }
      }
    });

    const outcome = await createAdminProviderDraftTester({
      createFetch: () => fetchFn
    }).test(configured);

    expect(outcome.evidence.compatibility).toMatchObject({
      forcedToolCall: "not_supported",
      structuredOutput: "verified"
    });
    expect(outcome.evidence).not.toHaveProperty("forcedToolCall");
  });

  it("records a route-level forced-call 404 as unsupported after access succeeds", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      if (body.stream === true) return streamedChatResponse();
      const tools = body.tools as Array<{
        function?: { name?: string };
      }> | undefined;
      const name = tools?.[0]?.function?.name;
      if (name === "aiqsa_structured_output_probe") {
        return strictToolChatResponse(name, {
          count: 2,
          label: "AIQSA",
          ready: true,
          tool_ids: ["alpha", "beta"]
        });
      }
      if (name === "aiqsa_forced_tool_call_probe") {
        return new Response(JSON.stringify({
          error: { code: 404, message: "No endpoint supports these parameters." }
        }), { headers: { "content-type": "application/json" }, status: 404 });
      }
      return structuredChatResponse();
    });
    const configured = input({
      mode: "tiny_generation",
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, toolCalling: true }
      }
    });

    const outcome = await createAdminProviderDraftTester({
      createFetch: () => fetchFn
    }).test(configured);

    expect(outcome).toMatchObject({
      evidence: {
        compatibility: {
          forcedToolCall: "not_supported",
          modelAccess: "verified",
          streaming: "verified"
        }
      },
      status: "available"
    });
    expect(outcome.evidence).not.toHaveProperty("forcedToolCall");
  });

  it("verifies all five answer-model compatibility contracts", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      return body.stream === true
        ? streamedChatResponse()
        : structuredChatResponse(Array.isArray(body.tools));
    });
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => fetchFn,
      pdfInputProbe: {
        async probe() {
          return {
            adapterKind: "openrouter_chat_completions" as const,
            probeVersion: 1 as const,
            upstreamModelId: "vendor/model",
            verified: true as const
          };
        }
      }
    });

    await expect(providerTester.test(input())).resolves.toMatchObject({
      evidence: {
        compatibility: {
          directPdf: "verified",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "verified",
          structuredOutput: "verified",
          usage: "verified"
        },
        pdfInput: { verified: true },
        structuredOutput: { verified: true }
      },
      status: "available"
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream: false
    });
    expect(JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body))).toMatchObject({
      stream: true
    });
  });

  it("runs the PDF probe even when Direct PDF input is not preconfigured", async () => {
    const probe = vi.fn(async () => null);
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => async () => structuredChatResponse(),
      pdfInputProbe: { probe }
    });

    await expect(providerTester.test(input())).resolves.toMatchObject({
      evidence: { detail: "ok" },
      status: "available"
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("adds exact PDF evidence after a successful image-only probe", async () => {
    const probe = vi.fn(async () => ({
      adapterKind: "openrouter_chat_completions" as const,
      probeVersion: 1 as const,
      upstreamModelId: "vendor/model",
      verified: true as const
    }));
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => async () => structuredChatResponse(),
      pdfInputProbe: { probe }
    });
    const direct = input({
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, nativePdfInput: true, pdf: true }
      }
    });

    await expect(providerTester.test(direct)).resolves.toMatchObject({
      evidence: {
        pdfInput: {
          adapterKind: "openrouter_chat_completions",
          probeVersion: 1,
          upstreamModelId: "vendor/model",
          verified: true
        }
      },
      status: "available"
    });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "credential-1",
      credentialVersionId: "draft:1",
      model: expect.objectContaining({ upstreamModelId: "vendor/model" })
    }));
  });

  it("keeps ordinary model availability when the PDF probe fails", async () => {
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => async () => structuredChatResponse(),
      pdfInputProbe: {
        async probe() {
          throw new Error("private upstream PDF failure");
        }
      }
    });
    const direct = input({
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, nativePdfInput: true, pdf: true }
      }
    });

    const outcome = await providerTester.test(direct);
    expect(outcome.status).toBe("available");
    expect(outcome.evidence).not.toHaveProperty("pdfInput");
  });

  it("does not convert a transient capability failure into Not supported", async () => {
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => async () => structuredChatResponse(),
      pdfInputProbe: {
        async probe() {
          throw new Error("OpenAI request failed with status 503");
        }
      }
    });

    await expect(providerTester.test(input())).rejects.toThrow(
      "OpenAI request failed with status 503"
    );
  });

  it("checks embedding deployments against the OpenRouter embedding catalog", async () => {
    const listModels = vi.fn<OpenRouterDiscoveryClient["listModels"]>(async () => []);
    const listEmbeddingModels = vi.fn<OpenRouterDiscoveryClient["listEmbeddingModels"]>(async () => [{
      id: "qwen/qwen3-embedding-8b",
      inputModalities: [],
      name: "Qwen3 Embedding 8B",
      outputModalities: [],
      pricing: {},
      supportedParameters: []
    }]);
    const createFetch = vi.fn(() => async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 4_096 }, (_, index) => index === 0 ? 1 : 0), index: 0 }],
      model: "qwen/qwen3-embedding-8b",
      usage: { prompt_tokens: 4, total_tokens: 4 }
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const tester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({ listEmbeddingModels, listModels }),
      createFetch
    });

    await expect(tester.test(input({
      model: {
        adapterKind: "openai_embeddings_compatible",
        answerSelectable: false,
        capabilities: {
          contextWindow: 32_768,
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        embedding: {
          nativeDimension: 4_096,
          providerFamily: "openrouter",
          queryInstructionTemplate: "Query: {text}",
          supportsMrl: true,
          targetDimension: 1_536
        },
        modelClass: "embedding",
        upstreamModelId: "qwen/qwen3-embedding-8b"
      },
      modelDisplayName: "Qwen3 Embedding 8B"
    }))).resolves.toMatchObject({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "verified"
        },
        detail: "ok",
        selectedProviders: [],
        upstreamModelId: "qwen/qwen3-embedding-8b"
      },
      status: "available"
    });
    expect(listEmbeddingModels).toHaveBeenCalledOnce();
    expect(listModels).not.toHaveBeenCalled();
    expect(createFetch).toHaveBeenCalledOnce();
  });

  it("checks reranker deployments with a bounded score-only probe", async () => {
    const listModels = vi.fn<OpenRouterDiscoveryClient["listModels"]>(async () => []);
    const listRerankModels = vi.fn<OpenRouterDiscoveryClient["listRerankModels"]>(async () => [{
      id: "qwen/qwen3-reranker-8b",
      inputModalities: ["text"],
      name: "Qwen3 Reranker 8B",
      outputModalities: ["rerank"],
      pricing: {},
      supportedParameters: []
    }]);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "rerank-probe-1",
      model: "qwen/qwen3-reranker-8b",
      provider: "Together",
      results: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.1 }
      ],
      usage: { prompt_tokens: 9, total_tokens: 9 }
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const createFetch = vi.fn(() => fetchFn);
    const tester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({ listModels, listRerankModels }),
      createFetch
    });

    const outcome = await tester.test(input({
      model: {
        adapterKind: "openrouter_rerank",
        answerSelectable: false,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          streaming: false,
          toolCalling: false,
          vision: false
        },
        defaultParams: {},
        modelClass: "reranker",
        openRouterRouting: { mode: "automatic", providers: [] },
        upstreamModelId: "qwen/qwen3-reranker-8b"
      },
      modelDisplayName: "Qwen3 Reranker 8B"
    }));

    expect(outcome).toMatchObject({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "verified"
        },
        detail: "ok",
        upstreamModelId: "qwen/qwen3-reranker-8b"
      },
      status: "available"
    });
    expect(listRerankModels).toHaveBeenCalledOnce();
    expect(listModels).not.toHaveBeenCalled();
    expect(createFetch).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      documents: [
        "A bounded unrelated provider check.",
        "AIQSA reranker compatibility check."
      ],
      query: "AIQSA reranker compatibility check",
      top_n: 2
    });
  });

  it("uses the credential-specific OpenRouter account catalog", async () => {
    const listModels = vi.fn<OpenRouterDiscoveryClient["listModels"]>(async () => []);
    const createDiscoveryClient = vi.fn(() => discovery({ listModels }));
    const providerTester = createAdminProviderDraftTester({ createDiscoveryClient });

    await expect(providerTester.test(input())).resolves.toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "not_supported",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "not_supported"
        },
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "unavailable"
    });
    expect(createDiscoveryClient).toHaveBeenCalledWith({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://openrouter.ai/api/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      secret: "secret"
    });
    expect(listModels).toHaveBeenCalledOnce();
  });

  it("requires every selected OpenRouter downstream endpoint", async () => {
    const listModelEndpoints = vi.fn<OpenRouterDiscoveryClient["listModelEndpoints"]>(async () => [{
      name: "Provider A",
      providerName: "Provider A",
      supportedParameters: [],
      tag: "provider-a"
    }]);
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({ listModelEndpoints })
    });
    const selected = input({
      model: {
        ...input().model,
        openRouterRouting: {
          mode: "only_selected",
          providers: ["provider-a", "provider-b"]
        }
      }
    });

    await expect(providerTester.test(selected)).resolves.toMatchObject({
      evidence: {
        detail: "route_missing",
        selectedProviders: ["provider-a", "provider-b"]
      },
      status: "unavailable"
    });
    expect(listModelEndpoints).toHaveBeenCalledWith("vendor/model", {
      signal: undefined
    });
  });

  it("matches OpenRouter route tags case-insensitively without changing evidence", async () => {
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery({
        async listModelEndpoints() {
          return [{
            name: "Anthropic",
            providerName: "Anthropic",
            supportedParameters: [],
            tag: "anthropic"
          }];
        }
      }),
      createFetch: () => async (_url, request) => {
        const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
        return structuredChatResponse(Array.isArray(body.tools));
      }
    });
    const selected = input({
      model: {
        ...input().model,
        openRouterRouting: {
          mode: "only_selected",
          providers: ["Anthropic"]
        }
      }
    });

    await expect(providerTester.test(selected)).resolves.toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "verified",
          usage: "verified"
        },
        detail: "ok",
        method: "openrouter_account_catalog",
        selectedProviders: ["Anthropic"],
        structuredOutput: {
          adapterKind: "openrouter_chat_completions",
          probeVersion: 4,
          upstreamModelId: "vendor/model",
          verified: true
        },
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
  });

  it("keeps model access verified when an OpenRouter backend ignores a required tool call", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "ordinary free-form reply", role: "assistant" }
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => fetchFn
    });

    await expect(providerTester.test(input())).resolves.toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "not_supported"
        },
        detail: "ok",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    const [, request] = fetchFn.mock.calls[1] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      provider: { require_parameters: true },
      tool_choice: "required",
      tools: [{ type: "function" }]
    });
  });

  it("keeps Direct PDF evidence when the independent structured-output probe fails", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "ordinary free-form reply", role: "assistant" }
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery(),
      createFetch: () => fetchFn,
      pdfInputProbe: {
        async probe() {
          return {
            adapterKind: "openrouter_chat_completions" as const,
            probeVersion: 1 as const,
            upstreamModelId: "vendor/model",
            verified: true as const
          };
        }
      }
    });
    const direct = input({
      model: {
        ...input().model,
        capabilities: { ...input().model.capabilities, nativePdfInput: true, pdf: true }
      }
    });

    const outcome = await providerTester.test(direct);
    expect(outcome).toMatchObject({
      evidence: {
        pdfInput: { verified: true },
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    expect(outcome.evidence).not.toHaveProperty("structuredOutput");
  });

  it("records explicit negatives when optional probes prove nothing", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "ordinary free-form reply", role: "assistant" }
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });

    const outcome = await providerTester.test(input({ mode: "tiny_generation" }));

    expect(outcome).toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "not_supported"
        },
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    const firstBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    const fourthBody = JSON.parse(String(fetchFn.mock.calls[3]?.[1]?.body));
    expect(firstBody).not.toHaveProperty("response_format");
    expect(secondBody).toMatchObject({
      tool_choice: "required",
      tools: [{ type: "function" }]
    });
    expect(fourthBody).toMatchObject({ stream: true });
  });

  it("runs the explicit tiny generation through the existing runtime adapter and stores no output", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "private output", role: "assistant" } }],
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({
      createFetch: () => fetchFn
    });
    const compatible = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://compatible.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind: "openai_chat_completions_compatible",
        openRouterRouting: undefined
      },
      providerFamily: "openai_compatible"
    });

    const result = await providerTester.test(compatible);
    expect(result).toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 1,
          streaming: "not_supported",
          structuredOutput: "not_supported",
          usage: "verified"
        },
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
    expect(JSON.stringify(result)).not.toContain("private output");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [endpoint, request] = fetchFn.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://compatible.example.test/v1/chat/completions");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      max_completion_tokens: 1_000,
      stream: false
    });
  });

  it("tests an explicit no-auth private compatible endpoint without a placeholder secret", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "OK", role: "assistant" } }],
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
      }));
    });
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });

    await expect(providerTester.test(input({
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none",
        responseTimeoutMs: 300_000
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind: "openai_chat_completions_compatible",
        openRouterRouting: undefined
      },
      providerFamily: "openai_compatible",
      secret: null
    }))).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not allow no-auth to enter the OpenRouter account-catalog path", async () => {
    const providerTester = createAdminProviderDraftTester({
      createDiscoveryClient: () => discovery()
    });
    await expect(providerTester.test(input({ secret: null })))
      .rejects.toThrow("provider_credential_missing");
  });

  it("gives an OpenRouter reasoning diagnostic the standard output budget", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      return structuredChatResponse(Array.isArray(body.tools));
    });
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const openRouter = input({
      mode: "tiny_generation",
      model: {
        ...input().model,
        capabilities: {
          ...input().model.capabilities,
          reasoning: true
        },
        defaultParams: {
          reasoning: {
            effort: "medium",
            enabled: true,
            exclude: false,
            maxTokens: 0
          }
        }
      }
    });

    await expect(providerTester.test(openRouter)).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    const [, request] = fetchFn.mock.calls[1] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      max_tokens: 1_024,
      provider: { require_parameters: true },
      stream: false,
      tool_choice: "required",
      tools: [{ type: "function" }]
    });
  });

  it.each([
    ["openai_responses_native", "openai"],
    ["openai_responses_compatible", "openai_compatible"]
  ] as const)("uses the standard diagnostic output budget for %s", async (adapterKind, providerFamily) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "response-1",
      output: [{
        content: [{
          text: JSON.stringify({
            count: 2,
            label: "AIQSA",
            ready: true,
            tool_ids: ["alpha", "beta"]
          }),
          type: "output_text"
        }],
        type: "message"
      }],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const responses = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://responses.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind,
        defaultParams: {
          reasoning: { effort: "high", summary: "detailed" }
        },
        openRouterRouting: undefined
      },
      providerFamily
    });

    await expect(providerTester.test(responses)).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    const [endpoint, request] = fetchFn.mock.calls[1] ?? [];
    expect(endpoint).toBe("https://responses.example.test/v1/responses");
    const requestBody = JSON.parse(String(request?.body));
    expect(requestBody).toMatchObject({
      ...(adapterKind === "openai_responses_native" ? { background: false } : {}),
      max_output_tokens: 128,
      store: false,
      stream: false,
      text: { format: { strict: true, type: "json_schema" } }
    });
    if (adapterKind === "openai_responses_compatible") {
      expect(requestBody).not.toHaveProperty("background");
    }
  });

  it("uses the standard diagnostic output budget for Anthropic", async () => {
    const body = [
      'data: {"type":"message_start","message":{"id":"message-1","model":"claude-test","usage":{"input_tokens":2}}}',
      "",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
      "",
      'data: {"type":"content_block_stop","index":0}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      'data: {"type":"message_stop"}',
      ""
    ].join("\n");
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
      status: 200
    }));
    const providerTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
    const anthropic = input({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.anthropic.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      mode: "tiny_generation",
      model: {
        ...input().model,
        adapterKind: "anthropic_messages",
        openRouterRouting: undefined
      },
      providerFamily: "anthropic"
    });

    await expect(providerTester.test(anthropic)).resolves.toMatchObject({
      evidence: { detail: "ok", method: "tiny_generation" },
      status: "available"
    });
    const [endpoint, request] = fetchFn.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.anthropic.test/v1/messages");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      max_tokens: 1_000,
      stream: true
    });
  });
});
