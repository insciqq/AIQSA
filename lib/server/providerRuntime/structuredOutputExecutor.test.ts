import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createMcpSemanticRouter } from "../mcp/router";
import {
  buildGeminiInteractionsStructuredOutputRequest,
  buildOpenAIResponsesStructuredOutputRequest,
  type ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import type { ProviderAdmissionRole } from "./admission";
import {
  assertAcceptedStructuredOutputSnapshotExecutable,
  createAcceptedStructuredOutputExecutor,
  createAcceptedStructuredOutputSnapshotExecutor
} from "./structuredOutputExecutor";

const KEY = Buffer.alloc(32, 19);

function role(structuredOutput = true): ProviderAdmissionRole {
  const capabilities = {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: true,
    ...(structuredOutput ? { structuredOutput: true } : {}),
    vision: false
  };
  return {
    authority: {
      connectionId: "connection-1",
      connectionVersion: 2,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      modelVersion: 3,
      providerModelId: "provider-model-1"
    },
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: "openai_responses_native",
      capabilities,
      defaultParams: {}
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.openai.example.test/v1",
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
        capabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "gpt-structured"
      },
      modelDisplayName: "Structured model",
      providerFamily: "openai",
      providerModelId: "provider-model-1",
      version: 1
    }
  };
}

const request = {
  name: "router_selection",
  schema: {
    additionalProperties: false,
    properties: { serverIds: { items: { type: "string" }, type: "array" } },
    required: ["serverIds"],
    type: "object"
  },
  systemPrompt: "Return only the schema result.",
  userPrompt: "Choose servers."
} as const;

function geminiRole(apiVersion = "v1"): ProviderAdmissionRole {
  const base = role();
  return {
    ...base,
    modelConfiguration: { ...base.modelConfiguration, adapterKind: "gemini_interactions_native" },
    snapshot: {
      ...base.snapshot, providerFamily: "gemini",
      connection: { ...base.snapshot.connection, apiRoot: `https://gemini.example.test/${apiVersion}` },
      model: { ...base.snapshot.model, adapterKind: "gemini_interactions_native", modelClass: "answer",
        answerSelectable: true, upstreamModelId: "gemini-structured-test" }
    }
  };
}

function geminiExecutorFixture(value: unknown, apiVersion = "v1", responseForRequest?: (
  body: Record<string, unknown>, index: number
) => Response) {
  const admitted = geminiRole(apiVersion);
  const envelope = encryptProviderCredentialSecret({
    credentialId: "credential-1", key: KEY, secret: "runtime-secret", valueId: "credential-version-1"
  });
  let revoked = false;
  const queryRaw = vi.fn(async () => [{ credentialId: "credential-1", id: "credential-version-1",
    revokedAt: revoked ? new Date("2026-09-09T00:00:00Z") : null,
    secretEnvelope: envelope, testEvidence: { authenticationMode: "bearer" } }]);
  const client = { $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
    consume({ $queryRaw: queryRaw })) } as unknown as PrismaClient;
  const fetchFn = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
    expect(url).toBe(`https://gemini.example.test/${apiVersion}/interactions`);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("runtime-secret");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "gemini-structured-test", store: false, stream: false,
      response_format: { mime_type: "application/json", type: "text" } });
    expect(body.tools).toBeUndefined();
    if (responseForRequest) return responseForRequest(body, fetchFn.mock.calls.length);
    return Response.json({ id: "native-structured-1", status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }],
      usage: { total_input_tokens: 20, total_output_tokens: 8, total_thought_tokens: 4,
        total_cached_tokens: 5, total_tokens: 32 } });
  });
  const execute = createAcceptedStructuredOutputExecutor(client, { createFetch: () => fetchFn, encryptionKey: () => KEY });
  const requests: ProviderStructuredOutputRequest[] = [];
  const router = createMcpSemanticRouter({ executeStructuredOutput: (role, request, options) => {
    requests.push(structuredClone(request));
    return execute(role, request, options);
  }, resolveSystemModel: async () => ({
    ok: true, credentialScope: "installation", policyVersion: 1, providerModelId: admitted.snapshot.providerModelId,
    reasoningEffort: null, role: admitted
  }) });
  return { admitted, execute, fetchFn, queryRaw, requests, router, revoke() { revoked = true; } };
}

const nativeRouterInput: Parameters<ReturnType<typeof createMcpSemanticRouter>["route"]>[0] = {
  activeToolNames: new Set<string>(),
  catalog: { version: 1 as const, servers: [{ description: "Synthetic item lookup", namespace: "sample", revisionId: "revision-1", serverId: "server-1",
    serverName: "Sample", tools: [{ description: "Look up a synthetic item", namespacedName: "mcp_sample_lookup_1234567890", originalName: "lookup" }] }] },
  goals: ["Look up the sample item"], limit: 2,
  request: { content: { blocks: [{ type: "text", text: "Look up the sample item" }] } }
};
const nativeSelection = { mcp_needed: true, requirements: [{
  outcome: "Find the sample item", status: "covered", tool_ids: ["mcp_sample_lookup_1234567890"]
}] };

const routingCatalogInput = {
  ...nativeRouterInput, limit: 10,
  catalog: { ...nativeRouterInput.catalog, servers: [{ ...nativeRouterInput.catalog.servers[0]!,
    tools: Array.from({ length: 31 }, (_, index) => ({
      description: "Read a synthetic item", originalName: `lookup_${index}`,
      namespacedName: `mcp_sample_lookup_${index}`
    }))
  }] }
};
const selectedRoutingIds = routingCatalogInput.catalog.servers[0]!.tools.slice(0, 10).map((tool) => tool.namespacedName);
const routingSelection = { mcp_needed: true, requirements: [{
  outcome: "Read the requested items", status: "covered", tool_ids: selectedRoutingIds
}] };

describe("accepted structured-output executor", () => {
  it("executes admitted Anthropic JSON through the native runtime and rechecks credential revocation before I/O", async () => {
    const base = role();
    const admitted: ProviderAdmissionRole = {
      ...base, modelConfiguration: { ...base.modelConfiguration, adapterKind: "anthropic_messages" },
      snapshot: { ...base.snapshot, providerFamily: "anthropic",
        connection: { ...base.snapshot.connection, apiRoot: "https://anthropic.example.test/v1" },
        model: { ...base.snapshot.model, adapterKind: "anthropic_messages", upstreamModelId: "claude-structured-test",
          answerSelectable: true, modelClass: "answer" } }
    };
    const envelope = encryptProviderCredentialSecret({ credentialId: "credential-1", key: KEY,
      secret: "synthetic-anthropic-key", valueId: "credential-version-1" });
    let revoked = false;
    const queryRaw = vi.fn(async () => [{ credentialId: "credential-1", id: "credential-version-1",
      revokedAt: revoked ? new Date() : null, secretEnvelope: envelope, testEvidence: { authenticationMode: "bearer" } }]);
    const client = { $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
      consume({ $queryRaw: queryRaw })) } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://anthropic.example.test/v1/messages");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-anthropic-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-structured-test", stream: false,
        output_config: { format: { type: "json_schema" } } });
      return Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", id: "msg-runtime-test",
        content: [{ type: "text", text: JSON.stringify(nativeSelection) }], usage: { input_tokens: 15, output_tokens: 6 } });
    });
    const execute = createAcceptedStructuredOutputExecutor(client, { createFetch: () => fetchFn, encryptionKey: () => KEY });
    const router = createMcpSemanticRouter({ executeStructuredOutput: execute, resolveSystemModel: async () => ({
      ok: true, credentialScope: "installation", policyVersion: 1, providerModelId: admitted.snapshot.providerModelId,
      reasoningEffort: null, role: admitted
    }) });
    await expect(router.route(nativeRouterInput)).resolves.toMatchObject({ toolNames: ["mcp_sample_lookup_1234567890"],
      usageAttribution: { provider: "anthropic", usage: { inputTokens: 15, outputTokens: 6, totalTokens: 21 } } });
    expect(fetchFn).toHaveBeenCalledOnce();
    revoked = true;
    await expect(execute(admitted, request)).rejects.toThrow("credential_revoked");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("routes 31 Gemini tools through the native executor and one accounted coverage repair without weakening canonical bounds", async () => {
    const fixture = geminiExecutorFixture(null, "v1beta", (body, index) => {
      const wire = (body.response_format as { schema: Record<string, unknown> }).schema;
      expect(wire).toMatchObject({ additionalProperties: false, required: ["mcp_needed", "requirements"], properties: {
        requirements: { type: "array", items: { additionalProperties: false,
          required: ["outcome", "status", "tool_ids"], properties: {
            status: { enum: ["covered", "uncovered"] }, tool_ids: { items: {
              enum: routingCatalogInput.catalog.servers[0]!.tools.map((tool) => tool.namespacedName)
            } }
          } } }
      } });
      // The synthetic upstream reproduces the observed request rejection.
      if (JSON.stringify(wire).includes('"maxItems"')) {
        return Response.json({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY" } }, { status: 400 });
      }
      expect(body.generation_config).toEqual({ max_output_tokens: 8192, thinking_level: "medium", thinking_summaries: "none" });
      const value = index === 1 ? { mcp_needed: true, requirements: [{
        outcome: "Read the requested items", status: "uncovered", tool_ids: []
      }] } : routingSelection;
      return Response.json({ id: `native-routing-${index}`, status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }],
        usage: { total_input_tokens: 20, total_output_tokens: 8, total_thought_tokens: 4, total_tokens: 32 }
      });
    });
    fixture.admitted.modelConfiguration.capabilities.reasoning = true;
    fixture.admitted.modelConfiguration.capabilities.defaultReasoningEffort = "medium";
    fixture.admitted.modelConfiguration.capabilities.reasoningEfforts = ["medium"];
    await expect(fixture.router.route(routingCatalogInput)).resolves.toMatchObject({ toolNames: selectedRoutingIds,
      usageAttribution: { provider: "gemini", usage: { inputTokens: 40, outputTokens: 24, totalTokens: 64 } }
    });
    expect(fixture.fetchFn).toHaveBeenCalledTimes(2);
    expect(fixture.requests.map((request) => request.name)).toEqual(["mcp_tool_routing", "mcp_tool_routing_retry"]);
    for (const request of fixture.requests) {
      const canonical = structuredClone(request.schema);
      expect(canonical).toMatchObject({ properties: { requirements: { maxItems: 16,
        items: { properties: { tool_ids: { maxItems: 10, uniqueItems: true } } }
      } } });
      const control = buildGeminiInteractionsStructuredOutputRequest({
        ...fixture.admitted.snapshot.model, adapterKind: "gemini_interactions_native"
      }, { ...request, name: "unrelated_bounded_schema" });
      expect(control.response_format).toMatchObject({ schema: { properties: { requirements: { maxItems: 16,
        items: { properties: { tool_ids: { maxItems: 10 } } }
      } } } });
      const portable = buildOpenAIResponsesStructuredOutputRequest({ adapterKind: "openai_responses_native", upstreamModelId: "gpt-router" }, request);
      expect(portable.text).toMatchObject({ format: { schema: { properties: { requirements: { maxItems: 16,
        items: { properties: { tool_ids: { maxItems: 10 } } }
      } } } } });
      expect(request.schema).toEqual(canonical);
    }
    // The unchanged nested bounds receive the original native rejection.
    await expect(fixture.execute(fixture.admitted, { ...fixture.requests[0]!, name: "original_schema_control" }))
      .rejects.toMatchObject({ httpStatus: 400, code: "invalid_request" });
    expect(fixture.fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: "17 requirements", value: { mcp_needed: true, requirements: Array.from({ length: 17 }, (_, index) => ({
      outcome: `Outcome ${index}`, status: "covered", tool_ids: [selectedRoutingIds[0]]
    })) } },
    { label: "11 tools in one requirement", value: { mcp_needed: true, requirements: [{
      ...routingSelection.requirements[0], tool_ids: [...selectedRoutingIds, "mcp_sample_lookup_10"]
    }] } },
    { label: "unknown tool", value: { mcp_needed: true, requirements: [{ ...routingSelection.requirements[0], tool_ids: ["unknown"] }] } },
    { label: "duplicate tool", value: { mcp_needed: true, requirements: [{ ...routingSelection.requirements[0], tool_ids: [selectedRoutingIds[0], selectedRoutingIds[0]] }] } },
    { label: "invalid coverage", value: { mcp_needed: true, requirements: [{ ...routingSelection.requirements[0], status: "uncovered" }] } },
    { label: "invalid status enum", value: { mcp_needed: true, requirements: [{ ...routingSelection.requirements[0], status: "invented" }] } },
    { label: "duplicate outcome", value: { mcp_needed: true, requirements: [routingSelection.requirements[0], routingSelection.requirements[0]] } }
  ])("rejects $label under the canonical 31-tool routing contract after Gemini projection", async ({ value }) => {
    const fixture = geminiExecutorFixture(value);
    await expect(fixture.router.route(routingCatalogInput)).rejects.toMatchObject({ code: "mcp_router_output_invalid" });
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    { body: JSON.stringify({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY" } }), status: 400, code: "mcp_router_gemini_invalid_request" },
    { body: JSON.stringify({ error: { code: "parameter_unknown" } }), status: 400, code: "mcp_router_gemini_parameter_unknown" },
    { body: "{", status: 400, code: "mcp_router_request_rejected" },
    { body: JSON.stringify({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY".repeat(1000) } }), status: 400, code: "mcp_router_request_rejected" },
    { body: JSON.stringify({ error: { code: "invalid_request" } }), status: 503, code: "mcp_router_request_failed" },
    { body: JSON.stringify({ error: { code: "invalid_request" } }), status: 401, code: "mcp_router_credential_unavailable" },
    { body: JSON.stringify({ error: { code: "malformed_tool_call" } }), status: 400, code: "mcp_router_output_invalid" }
  ])("preserves only the safe native routing failure $status/$code without repair or retry", async ({ body, status, code }) => {
    const fixture = geminiExecutorFixture(null, "v1beta", () => new Response(body, { status }));
    const error: unknown = await fixture.router.route(routingCatalogInput).catch((error: unknown) => error);
    expect(error).toMatchObject({ code, usageAttribution: null });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_UPSTREAM_BODY");
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["v1", "v1beta"])("executes Gemini through the authorized MCP consumer at its exact %s root", async (apiVersion) => {
    const fixture = geminiExecutorFixture(nativeSelection, apiVersion);
    await expect(fixture.router.route(nativeRouterInput)).resolves.toEqual({
      toolNames: ["mcp_sample_lookup_1234567890"], usageAttribution: {
        provider: "gemini", modelId: "gemini-structured-test",
        usage: { cacheWriteInputTokens: 0, cachedInputTokens: 5, inputTokens: 20, outputTokens: 12, reasoningTokens: 4, totalTokens: 32 }
      }
    });
    expect(fixture.queryRaw).toHaveBeenCalledOnce();
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
    fixture.revoke();
    await expect(fixture.execute(fixture.admitted, request)).rejects.toThrow("credential_revoked");
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    { mcp_needed: true },
    { ...nativeSelection, extra: true },
    { mcp_needed: true, requirements: [{ ...nativeSelection.requirements[0], tool_ids: ["unknown"] }] },
    { mcp_needed: true, requirements: [{ ...nativeSelection.requirements[0], tool_ids: ["mcp_sample_lookup_1234567890", "mcp_sample_lookup_1234567890"] }] },
    { mcp_needed: true, requirements: [{ ...nativeSelection.requirements[0], outcome: "" }] },
    { mcp_needed: true, requirements: [{ ...nativeSelection.requirements[0], outcome: "x".repeat(161) }] },
    { mcp_needed: true, requirements: [{ ...nativeSelection.requirements[0], status: "invented" }] }
  ])("retains the authoritative MCP decoder after Gemini wire projection (%#)", async (value) => {
    const fixture = geminiExecutorFixture(value);
    await expect(fixture.router.route(nativeRouterInput)).rejects.toMatchObject({
      code: "mcp_router_output_invalid", usageAttribution: { provider: "gemini", usage: { totalTokens: 32 } }
    });
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["unverified", "connection", "credential", "model"])("fences a Gemini %s authority mismatch before dispatch", async (failure) => {
    const fixture = geminiExecutorFixture(nativeSelection);
    const admitted = fixture.admitted;
    const changed = failure === "unverified" ? { ...admitted, modelConfiguration: {
      ...admitted.modelConfiguration, capabilities: { ...admitted.modelConfiguration.capabilities, structuredOutput: false }
    } } : { ...admitted, authority: { ...admitted.authority!,
      ...(failure === "connection" ? { connectionId: "other" }
        : failure === "credential" ? { credentialVersionId: "other" } : { providerModelId: "other" })
    } };
    await expect(fixture.execute(changed, request)).rejects.toThrow("structured_output_not_supported");
    expect(fixture.queryRaw).not.toHaveBeenCalled();
    expect(fixture.fetchFn).not.toHaveBeenCalled();
  });

  it("attests exact credential decryptability without provider network work", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key: KEY,
      secret: "runtime-secret",
      valueId: "credential-version-1"
    });
    const queryRaw = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const client = {
      $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
        consume({ $queryRaw: queryRaw }))
    } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>();

    await expect(assertAcceptedStructuredOutputSnapshotExecutable(
      client,
      role().snapshot,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    )).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(assertAcceptedStructuredOutputSnapshotExecutable(
      client,
      role().snapshot,
      { createFetch: () => fetchFn, encryptionKey: () => Buffer.alloc(32, 20) }
    )).rejects.toMatchObject({
      message: "secret_encryption_invalid_envelope",
      name: "SecretEnvelopeError"
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("locks and decrypts the admitted credential at each strict-schema request", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key: KEY,
      secret: "runtime-secret",
      valueId: "credential-version-1"
    });
    let revoked = false;
    const queryRaw = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: revoked ? new Date("2026-08-16T00:00:00.000Z") : null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const client = {
      $transaction: vi.fn(async (consume: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
        consume({ $queryRaw: queryRaw }))
    } as unknown as PrismaClient;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-structured",
        stream: false,
        text: { format: { name: "router_selection", strict: true, type: "json_schema" } }
      });
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ serverIds: ["mcp-a"] }),
        status: "completed"
      }), { status: 200 });
    });
    const execute = createAcceptedStructuredOutputExecutor(client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });

    await expect(execute(role(), request)).resolves.toEqual({ serverIds: ["mcp-a"] });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();

    const executeSnapshot = createAcceptedStructuredOutputSnapshotExecutor(client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });
    await expect(executeSnapshot(role().snapshot, request)).resolves.toEqual({
      serverIds: ["mcp-a"]
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    revoked = true;
    await expect(execute(role(), request)).rejects.toThrow("credential_revoked");
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails before credential or network work without verified capability", async () => {
    const transaction = vi.fn();
    const fetchFn = vi.fn<typeof fetch>();
    const execute = createAcceptedStructuredOutputExecutor(
      { $transaction: transaction } as unknown as PrismaClient,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }
    );

    await expect(execute(role(false), request)).rejects.toThrow(
      "structured_output_not_supported"
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
