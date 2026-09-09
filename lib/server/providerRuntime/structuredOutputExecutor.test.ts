import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createMcpSemanticRouter } from "../mcp/router";
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

function geminiExecutorFixture(value: unknown, apiVersion = "v1") {
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
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(`https://gemini.example.test/${apiVersion}/interactions`);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("runtime-secret");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "gemini-structured-test", store: false, stream: false,
      response_format: { mime_type: "application/json", type: "text" } });
    expect(body.tools).toBeUndefined();
    return Response.json({ id: "native-structured-1", status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }],
      usage: { total_input_tokens: 20, total_output_tokens: 8, total_thought_tokens: 4,
        total_cached_tokens: 5, total_tokens: 32 } });
  });
  const execute = createAcceptedStructuredOutputExecutor(client, { createFetch: () => fetchFn, encryptionKey: () => KEY });
  const router = createMcpSemanticRouter({ executeStructuredOutput: execute, resolveSystemModel: async () => ({
    ok: true, credentialScope: "installation", policyVersion: 1, providerModelId: admitted.snapshot.providerModelId,
    reasoningEffort: null, role: admitted
  }) });
  return { admitted, execute, fetchFn, queryRaw, router, revoke() { revoked = true; } };
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

describe("accepted structured-output executor", () => {
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
