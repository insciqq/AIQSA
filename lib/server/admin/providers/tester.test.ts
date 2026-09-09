import { describe, expect, it, vi } from "vitest";
import * as visionProbe from "../../providers/visionInputProbe";
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
  it.each(["memory", "vision"] as const)("runs only the requested %s capability probes", async (capabilityRole) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      bodies.push(body);
      if (JSON.stringify(body.messages).includes("image_url")) return Response.json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "V4K8M2" } }]
      });
      const name = body.tools?.[0]?.function?.name;
      if (name === "aiqsa_forced_tool_call_probe") return strictToolChatResponse(name, { nonce: "aiqsa-control-ready" });
      return structuredChatResponse();
    });
    const base = input();
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test({
      ...base, capabilityRole, mode: "tiny_generation",
      model: { ...base.model, capabilities: { ...base.model.capabilities, vision: true, nativePdfInput: true, toolCalling: true } }
    });
    expect(outcome.status).toBe("available");
    expect(bodies).toHaveLength(capabilityRole === "memory" ? 3 : 2);
    expect(bodies.every((body) => body.stream !== true)).toBe(true);
    expect(Boolean(outcome.evidence.visionInput)).toBe(capabilityRole === "vision");
    expect(Boolean(outcome.evidence.structuredOutput)).toBe(capabilityRole === "memory");
    expect(Boolean(outcome.evidence.forcedToolCall)).toBe(capabilityRole === "memory");
    expect(outcome.evidence.pdfInput).toBeUndefined();
  });

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
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test({
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

function structuredChatResponse() {
  return Response.json({
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }), role: "assistant" }
    }],
    usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 }
  });
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
  it.each(["verified", "ignored", "rejected"] as const)(
    "verifies ordinary tools and native JSON independently of a %s strict Memory call",
    async (strictResult) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
        const body = JSON.parse(String(request?.body));
        bodies.push(body);
        if (body.stream) return streamedChatResponse();
        const name = body.tools?.[0]?.function?.name;
        if (name === "aiqsa_tool_call_probe") return strictToolChatResponse(name, { city: "Oslo" });
        if (name === "aiqsa_forced_tool_call_probe") {
          if (strictResult === "verified") return strictToolChatResponse(name, { nonce: "aiqsa-control-ready" });
          if (strictResult === "rejected") return Response.json({ error: { code: 404 } }, { status: 404 });
        }
        return structuredChatResponse();
      });
      const configured = input({
        mode: "tiny_generation",
        model: { ...input().model, capabilities: { ...input().model.capabilities, toolCalling: true } }
      });
      const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test(configured);
      expect(outcome).toMatchObject({
        evidence: {
          compatibility: {
            toolCalling: "verified", structuredOutput: "verified",
            forcedToolCall: strictResult === "verified" ? "verified" : "not_supported",
            modelAccess: "verified", streaming: "verified"
          },
          structuredOutput: { adapterKind: "openrouter_chat_completions", probeVersion: 5, verified: true }
        },
        status: "available"
      });
      expect(Boolean(outcome.evidence.forcedToolCall)).toBe(strictResult === "verified");
      const structured = bodies.find((body) => body.response_format);
      expect(structured).toMatchObject({
        provider: { require_parameters: true }, response_format: { type: "json_schema", json_schema: { strict: true } }
      });
      expect(structured).not.toHaveProperty("tools");
      expect(structured).not.toHaveProperty("tool_choice");
      const ordinary = bodies.find((body) => body.tool_choice === "auto");
      expect(ordinary).toMatchObject({ tools: [{ function: { strict: false, name: "aiqsa_tool_call_probe" } }] });
      const forced = bodies.find((body) => body.tool_choice === "required");
      expect(forced).toMatchObject({ provider: { require_parameters: true }, tools: [{ function: { strict: true } }] });
      expect(forced).not.toHaveProperty("parallel_tool_calls");
    }
  );

  it.each(["wrong_name", "wrong_arguments", "no_call"])("does not verify ordinary tools from %s", async (failure) => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const name = body.tools?.[0]?.function?.name;
      if (name === "aiqsa_tool_call_probe" && failure !== "no_call") {
        return strictToolChatResponse(failure === "wrong_name" ? "other_function" : name,
          failure === "wrong_arguments" ? { city: "Oslo", extra: true } : { city: "Oslo" });
      }
      return body.stream ? streamedChatResponse() : structuredChatResponse();
    });
    const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test(input({
      mode: "tiny_generation",
      model: { ...input().model, capabilities: { ...input().model.capabilities, toolCalling: true } }
    }));
    expect(outcome.evidence.compatibility).toMatchObject({ toolCalling: "not_supported", structuredOutput: "verified" });
  });

  it.each([401, 429, 503])("fails the refresh on an ordinary-tool HTTP %s without publishing incompatibility", async (status) => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      return body.tools?.[0]?.function?.name === "aiqsa_tool_call_probe"
        ? Response.json({ error: { code: status } }, { status }) : structuredChatResponse();
    });
    await expect(createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test(input({
      mode: "tiny_generation",
      model: { ...input().model, capabilities: { ...input().model.capabilities, toolCalling: true } }
    }))).rejects.toThrow();
  });

  it("verifies all five answer-model compatibility contracts", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      return body.stream === true
        ? streamedChatResponse()
        : structuredChatResponse();
    });
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
          probeVersion: 2,
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const tester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
          probeVersion: 2,
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
    const tester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createDiscoveryClient });

    await expect(providerTester.test(input())).resolves.toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "not_supported",
          probeVersion: 2,
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
      createFetch: () => async () => structuredChatResponse()
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
          probeVersion: 2,
          streaming: "not_supported",
          structuredOutput: "verified",
          usage: "verified"
        },
        detail: "ok",
        method: "openrouter_account_catalog",
        selectedProviders: ["Anthropic"],
        structuredOutput: {
          adapterKind: "openrouter_chat_completions",
          probeVersion: 5,
          upstreamModelId: "vendor/model",
          verified: true
        },
        upstreamModelId: "vendor/model"
      },
      status: "available"
    });
  });

  it("keeps model access verified when an OpenRouter backend ignores native JSON Schema", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "ordinary free-form reply", role: "assistant" }
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
      createDiscoveryClient: () => discovery(),
      createFetch: () => fetchFn
    });

    await expect(providerTester.test(input())).resolves.toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 2,
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
      response_format: { type: "json_schema", json_schema: { strict: true } }
    });
  });

  it("keeps Direct PDF evidence when the independent structured-output probe fails", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: "ordinary free-form reply", role: "assistant" }
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });

    const outcome = await providerTester.test(input({ mode: "tiny_generation" }));

    expect(outcome).toEqual({
      evidence: {
        compatibility: {
          directPdf: "not_supported",
          modelAccess: "verified",
          probeVersion: 2,
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
      response_format: { type: "json_schema", json_schema: { strict: true } }
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
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
          probeVersion: 2,
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });

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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
      createDiscoveryClient: () => discovery()
    });
    await expect(providerTester.test(input({ secret: null })))
      .rejects.toThrow("provider_credential_missing");
  });

  it("gives an OpenRouter reasoning diagnostic the standard output budget", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => structuredChatResponse());
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });
    const openRouter = input({
      mode: "tiny_generation",
      model: {
        ...input().model,
        capabilities: {
          ...input().model.capabilities,
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high"],
          defaultReasoningEffort: "medium"
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
      response_format: { type: "json_schema", json_schema: { strict: true } }
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });
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
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });
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

function completedResponsesResponse(text = "OK") {
  return Response.json({
    id: "synthetic-response", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 }
  });
}

function responsesInput(capabilityRole?: AdminProviderDraftTesterInput["capabilityRole"]) {
  const base = input();
  return input({
    capabilityRole, mode: "tiny_generation", providerFamily: "openai_compatible",
    model: { ...base.model, adapterKind: "openai_responses_compatible", openRouterRouting: undefined }
  });
}

describe("Responses capability terminals", () => {
  it.each([
    ["memory", "incomplete"], ["memory", "failed"],
    ["direct_pdf", "incomplete"], ["direct_pdf", "failed"]
  ] as const)("fails %s on %s without publishing incompatibility", async (role, status) => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completedResponsesResponse())
      .mockImplementation(async () => Response.json({
        id: "synthetic-response", status, output: [],
        ...(status === "failed"
          ? { error: { code: "server_error", message: "Synthetic failure" } }
          : { incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 4, output_tokens: 512, total_tokens: 516 } })
      }));
    await expect(createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn })
      .test(responsesInput(role))).rejects.toThrow(role === "memory"
        ? status === "incomplete" ? "structured_output_output_limit_exceeded" : "structured_output_provider_incomplete"
        : `compatible_response_${status}`);
    expect(fetchFn).toHaveBeenCalledTimes(role === "memory" && status === "incomplete" ? 2 : 4);
  });
});

describe("capability check failure boundaries", () => {
  it.each(["memory", "direct_pdf"] as const)("keeps completed and rejected %s probes distinct", async (role) => {
    for (const result of ["verified", "wrong_answer", "unsupported"] as const) {
      const fetchFn = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(completedResponsesResponse())
        .mockResolvedValueOnce(result === "unsupported"
          ? Response.json({ error: { message: "Unsupported input" } }, { status: 400 })
          : completedResponsesResponse(result === "wrong_answer" ? "WRONG" : role === "memory"
            ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] })
            : "Q7K4P9"));
      const outcome = await createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test(responsesInput(role));
      expect(outcome.status).toBe("available");
      expect(outcome.evidence.compatibility?.modelAccess).toBe("verified");
      expect(outcome.evidence.compatibility?.[role === "memory" ? "structuredOutput" : "directPdf"])
        .toBe(result === "verified" ? "verified" : "not_supported");
      expect(Boolean(outcome.evidence[role === "memory" ? "structuredOutput" : "pdfInput"]))
        .toBe(result === "verified");
    }
  });

  it.each(["structured", "pdf"] as const)("fails a full model check on an incomplete %s response", async (capability) => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const isTarget = capability === "structured" ? Boolean(body.text?.format) : JSON.stringify(body.input).includes("input_file");
      return isTarget
        ? Response.json({ id: "synthetic-response", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } })
        : completedResponsesResponse(body.text?.format
          ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }) : "OK");
    });
    await expect(createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn }).test(responsesInput()))
      .rejects.toThrow(capability === "structured" ? "structured_output_output_limit_exceeded" : "compatible_response_incomplete");
    expect(fetchFn).toHaveBeenCalledTimes(capability === "structured" ? 2 : 5);
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("cancelled", "AbortError"),
    Object.assign(new Error("provider_run_aborted"), { name: "AbortError" }),
    Object.assign(new Error("timeout"), { code: "provider_request_timed_out" }),
    Object.assign(new Error("limit"), { code: "provider_response_too_large" }),
    new Error("compatible_response_cancelled"),
    new Error("compatible_response_not_completed"),
    new Error("openai_response_failed"),
    new Error("openai_response_incomplete"),
    new Error("openai_response_cancelled"),
    new Error("openai_response_not_completed")
  ])("preserves a represented transport/cancellation failure: %s", async (failure) => {
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
      createFetch: () => async () => completedResponsesResponse(),
      pdfInputProbe: { async probe() { throw failure; } }
    });
    await expect(providerTester.test(responsesInput("direct_pdf"))).rejects.toBe(failure);
  });

  it("preserves the caller cancellation reason during a capability probe", async () => {
    const controller = new AbortController();
    const providerTester = createAdminProviderDraftTester({ retrySleep: async () => {},
      createFetch: () => async () => completedResponsesResponse(),
      pdfInputProbe: { async probe() { controller.abort("capability_check_cancelled"); throw new Error("ignored"); } }
    });
    await expect(providerTester.test({ ...responsesInput("direct_pdf"), signal: controller.signal }))
      .rejects.toBe("capability_check_cancelled");
  });

  it.each([undefined, "vision"] as const)("fails the %s check when the local vision fixture is unavailable", async (capabilityRole) => {
    const probe = vi.spyOn(visionProbe, "createProviderVisionInputProbe").mockReturnValue({
      async probe() { throw new Error("vision_input_fixture_unavailable"); }
    });
    try {
      const base = input();
      await expect(createAdminProviderDraftTester({ retrySleep: async () => {},
        createFetch: () => async () => structuredChatResponse(),
        pdfInputProbe: { async probe() { return null; } }
      }).test({ ...base, capabilityRole, mode: "tiny_generation",
        model: { ...base.model, capabilities: { ...base.model.capabilities, vision: true } }
      })).rejects.toThrow("vision_input_fixture_unavailable");
    } finally {
      probe.mockRestore();
    }
  });
});
