import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
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
  // One provider attempt, so each case observes exactly the requests it sent.
  const execute = createAcceptedStructuredOutputExecutor(client, {
    createFetch: () => fetchFn, disableRequestRetries: true, encryptionKey: () => KEY
  });
  return { admitted, execute, fetchFn, queryRaw, revoke() { revoked = true; } };
}

const selection = { serverIds: ["server-1"] };

/** A bounded array inside another bounded array, as structured selections use. */
const nestedBoundsRequest: ProviderStructuredOutputRequest = {
  name: "nested_bounded_selection",
  schema: {
    additionalProperties: false,
    properties: { groups: { items: { additionalProperties: false, properties: {
      ids: { items: { type: "string" }, maxItems: 10, type: "array", uniqueItems: true }
    }, required: ["ids"], type: "object" }, maxItems: 16, type: "array" } },
    required: ["groups"],
    type: "object"
  },
  systemPrompt: "Return only the schema result.",
  userPrompt: "Group the items."
};

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
        content: [{ type: "text", text: JSON.stringify(selection) }], usage: { input_tokens: 15, output_tokens: 6 } });
    });
    const execute = createAcceptedStructuredOutputExecutor(client, { createFetch: () => fetchFn, encryptionKey: () => KEY });
    const onUsage = vi.fn();
    await expect(execute(admitted, request, { onUsage })).resolves.toEqual(selection);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 15, outputTokens: 6 }));
    expect(fetchFn).toHaveBeenCalledOnce();
    revoked = true;
    await expect(execute(admitted, request)).rejects.toThrow("credential_revoked");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("projects nested Gemini bounds without weakening the canonical request", async () => {
    const fixture = geminiExecutorFixture(null, "v1beta", (body) => {
      const wire = (body.response_format as { schema: Record<string, unknown> }).schema;
      const groups = (wire.properties as Record<string, Record<string, unknown>>).groups!;
      expect(groups.maxItems).toBe(16);
      expect(JSON.stringify(groups.items)).not.toContain('"maxItems"');
      return Response.json({ id: "native-nested", status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ groups: [{ ids: ["a"] }] }) }] }],
        usage: { total_input_tokens: 20, total_output_tokens: 8, total_tokens: 28 } });
    });
    const canonical = structuredClone(nestedBoundsRequest.schema);
    await expect(fixture.execute(fixture.admitted, nestedBoundsRequest)).resolves.toEqual({ groups: [{ ids: ["a"] }] });
    expect(nestedBoundsRequest.schema).toEqual(canonical);
    const portable = buildOpenAIResponsesStructuredOutputRequest({ adapterKind: "openai_responses_native", upstreamModelId: "gpt-structured" }, nestedBoundsRequest);
    expect(portable.text).toMatchObject({ format: { schema: { properties: { groups: { maxItems: 16,
      items: { properties: { ids: { maxItems: 10 } } } } } } } });
    const control = buildGeminiInteractionsStructuredOutputRequest({
      ...fixture.admitted.snapshot.model, adapterKind: "gemini_interactions_native"
    }, nestedBoundsRequest);
    expect(control.response_format).toHaveProperty("schema.properties.groups.maxItems", 16);
  });

  it.each([
    { body: JSON.stringify({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY" } }), status: 400 },
    { body: JSON.stringify({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY".repeat(1000) } }), status: 400 },
    { body: JSON.stringify({ error: { code: "invalid_request", message: "PRIVATE_UPSTREAM_BODY" } }), status: 503 }
  ])("fails a rejected Gemini request $status once without exposing the upstream body", async ({ body, status }) => {
    const fixture = geminiExecutorFixture(null, "v1beta", () => new Response(body, { status }));
    const error: unknown = await fixture.execute(fixture.admitted, request).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("PRIVATE_UPSTREAM_BODY");
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["v1", "v1beta"])("executes Gemini at its exact %s root and rechecks credential revocation", async (apiVersion) => {
    const fixture = geminiExecutorFixture(selection, apiVersion);
    const onUsage = vi.fn();
    await expect(fixture.execute(fixture.admitted, request, { onUsage })).resolves.toEqual(selection);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ cachedInputTokens: 5, inputTokens: 20, totalTokens: 32 }));
    expect(fixture.queryRaw).toHaveBeenCalledOnce();
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
    fixture.revoke();
    await expect(fixture.execute(fixture.admitted, request)).rejects.toThrow("credential_revoked");
    expect(fixture.fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["unverified", "connection", "credential", "model"])("fences a Gemini %s authority mismatch before dispatch", async (failure) => {
    const fixture = geminiExecutorFixture(selection);
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
        text: { format: { name: "router_selection", strict: true, type: "json_schema" } }
      });
      expect(body).not.toHaveProperty("stream");
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
