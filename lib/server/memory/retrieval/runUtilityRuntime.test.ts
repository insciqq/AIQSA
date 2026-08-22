import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  createAcceptedMemoryRunUtilityProvider,
  memoryRunUtilityProviderEvidence,
  MEMORY_RERANK_TOOL_NAME
} from "./runUtilityRuntime";

const KEY = Buffer.alloc(32, 29);

function snapshot(
  adapterKind: "openai_chat_completions_compatible" |
    "openai_responses_compatible" |
    "openai_responses_native" |
    "openrouter_chat_completions" =
    "openai_chat_completions_compatible",
  requiresStrictStructuredOutput = true
): MemorySecretFreeExecutionSnapshot {
  return {
    acceptedUtilityEgressFingerprint: "a".repeat(64),
    compatibilityId: "compatibility-1",
    compatibilityRequirement: {
      compatibilityVersion: "memory-runtime-compatibility-v2",
      configFingerprint: "b".repeat(64),
      deploymentFingerprint: "c".repeat(64),
      modelFingerprint: "d".repeat(64),
      pipelineVersion: "memory-rerank-v1",
      policyVersion: "memory-policy-v1",
      promptVersion: "memory-rerank-prompt-v1",
      providerFingerprint: "e".repeat(64),
      retrievalConfigFingerprint: "f".repeat(64),
      role: "MEMORY_RERANK",
      schemaVersion: "memory-rerank-schema-v3",
      vectorSpaceFingerprint: null
    },
    credentialSource: "default",
    destinationFingerprint: "1".repeat(64),
    executionTargetFingerprint: "2".repeat(64),
    logicalRole: "MEMORY_RERANK",
    providerExecutionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "Local compatible",
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind,
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          streaming: false,
          toolCalling: true,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        ...(adapterKind === "openrouter_chat_completions"
          ? { openRouterRouting: { mode: "automatic" as const, providers: [] } }
          : {}),
        upstreamModelId: adapterKind === "openai_responses_native"
          ? "gpt-test"
          : adapterKind === "openrouter_chat_completions"
            ? "openrouter/model"
            : "local/model"
      },
      modelDisplayName: "Local model",
      providerFamily: adapterKind === "openai_responses_native"
        ? "openai"
        : adapterKind === "openrouter_chat_completions"
          ? "openrouter"
        : "openai_compatible",
      providerModelId: "deployment-1",
      version: 1
    },
    policyRevision: 1,
    requiresStrictStructuredOutput,
    utilityPolicyVersion: "memory-utility-egress-v1",
    version: 2
  };
}

function client() {
  const secretEnvelope = encryptProviderCredentialSecret({
    credentialId: "credential-1",
    key: KEY,
    secret: "provider-test-secret",
    valueId: "credential-version-1"
  });
  const queryRaw = vi.fn(async () => [{
    credentialId: "credential-1",
    id: "credential-version-1",
    revokedAt: null,
    secretEnvelope,
    testEvidence: { authenticationMode: "bearer" }
  }]);
  const transaction = vi.fn(async (
    callback: (tx: Readonly<{ $queryRaw: typeof queryRaw }>) => Promise<unknown>
  ) => callback({ $queryRaw: queryRaw }));
  return {
    client: { $transaction: transaction } as never,
    queryRaw,
    transaction
  };
}

describe("Memory run utility provider runtime", () => {
  it.each([
    "openai_responses_compatible",
    "openai_responses_native",
    "openrouter_chat_completions"
  ] as const)(
    "uses admitted strict-output evidence for %s when model capabilities omit it",
    async (adapterKind) => {
      const fixture = client();
      const decision = JSON.stringify({
        decisions: [{
          applicable: true,
          current: true,
          handle: "c0",
          reason_code: "DIRECT_RELEVANCE",
          relevance_score: 0.95
        }]
      });
      const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as unknown
          : null;
        expect(JSON.stringify(body)).toContain(
          "SAVED outranks LEARNED, and LEARNED outranks PAST_CHAT"
        );
        expect(JSON.stringify(body)).toContain('\\"profile_requested\\":false');
        expect(JSON.stringify(body)).not.toContain("SENSITIVE");
        expect(body).toMatchObject(adapterKind === "openrouter_chat_completions"
          ? {
              max_completion_tokens: 4_096,
              response_format: { json_schema: { strict: true }, type: "json_schema" }
            }
          : {
              max_output_tokens: 4_096,
              text: { format: { strict: true, type: "json_schema" } }
            });
        return new Response(JSON.stringify(
          adapterKind === "openrouter_chat_completions"
            ? {
                choices: [{
                  finish_reason: "stop",
                  message: { content: decision, role: "assistant" }
                }],
                id: "response-1",
                model: "openrouter/model",
                usage: { completion_tokens: 12, prompt_tokens: 20, total_tokens: 32 }
              }
            : {
                id: "response-1",
                output: [{
                  content: [{ text: decision, type: "output_text" }],
                  id: "message-1",
                  role: "assistant",
                  status: "completed",
                  type: "message"
                }],
                status: "completed",
                usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }
              }
        ));
      });
      const provider = createAcceptedMemoryRunUtilityProvider(fixture.client, {
        createFetch: () => fetchFn,
        encryptionKey: () => KEY
      });
      const accepted = snapshot(adapterKind);

      expect(accepted.providerExecutionSnapshot.model.capabilities)
        .not.toHaveProperty("structuredOutput");
      await expect(provider.run(
        memoryRunUtilityProviderEvidence(accepted),
        {
          candidates: [{
            authorityLevel: "SAVED",
            current: true,
            handle: "c0",
            occurredFrom: null,
            occurredTo: null,
            sensitivityClass: "NORMAL",
            sourceKind: "FACT",
            text: "The user's name is Nebula."
          }],
          profileRequested: false,
          query: "What is my name?",
          role: "MEMORY_RERANK"
        },
        new AbortController().signal
      )).resolves.toMatchObject({
        providerResponseId: "response-1",
        toolCalls: [{ name: MEMORY_RERANK_TOOL_NAME }],
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 }
      });
      expect(fixture.transaction).toHaveBeenCalledOnce();
      expect(fixture.queryRaw).toHaveBeenCalledOnce();
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  );

  it("serializes ordinary and broad-profile requests into distinct provider payloads", async () => {
    const fixture = client();
    const requestBodies: string[] = [];
    const decision = JSON.stringify({
      decisions: [{
        applicable: true,
        current: true,
        handle: "c0",
        reason_code: "DIRECT_RELEVANCE",
        relevance_score: 0.95
      }]
    });
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as unknown
        : null;
      requestBodies.push(JSON.stringify(body));
      return new Response(JSON.stringify({
        id: "response-1",
        output: [{
          content: [{ text: decision, type: "output_text" }],
          id: "message-1",
          role: "assistant",
          status: "completed",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }
      }));
    });
    const provider = createAcceptedMemoryRunUtilityProvider(fixture.client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });
    const evidence = memoryRunUtilityProviderEvidence(snapshot(
      "openai_responses_compatible"
    ));
    const input = {
      candidates: [{
        authorityLevel: "SAVED" as const,
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
        sourceKind: "FACT" as const,
        text: "The user's name is Nebula."
      }],
      query: "What do you know about me?",
      role: "MEMORY_RERANK" as const
    };

    await provider.run(
      evidence,
      { ...input, profileRequested: false },
      new AbortController().signal
    );
    await provider.run(
      evidence,
      { ...input, profileRequested: true },
      new AbortController().signal
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toContain('\\"profile_requested\\":false');
    expect(requestBodies[1]).toContain('\\"profile_requested\\":true');
    expect(requestBodies[1]).not.toBe(requestBodies[0]);
  });

  it("rejects a binding without admitted strict-output evidence", () => {
    expect(() => memoryRunUtilityProviderEvidence(snapshot(
      "openai_responses_compatible",
      false
    )))
      .toThrow("memory_run_utility_binding_invalid");
  });

  it("rejects missing runtime strict-output evidence before credential or provider I/O", async () => {
    const fixture = client();
    const fetchFn = vi.fn<typeof fetch>();
    const provider = createAcceptedMemoryRunUtilityProvider(fixture.client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });
    const evidence = {
      ...memoryRunUtilityProviderEvidence(snapshot()),
      strictOutputVerified: false
    } as never;

    await expect(provider.run(
      evidence,
      {
        candidates: [],
        profileRequested: false,
        query: "query",
        role: "MEMORY_RERANK"
      },
      new AbortController().signal
    )).rejects.toThrow("memory_run_utility_runtime_invalid");
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a tool-only adapter that cannot carry verified strict structured output", async () => {
    const fixture = client();
    const fetchFn = vi.fn<typeof fetch>();
    const provider = createAcceptedMemoryRunUtilityProvider(fixture.client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });

    await expect(provider.run(
      memoryRunUtilityProviderEvidence(snapshot("openai_chat_completions_compatible")),
      {
        candidates: [],
        profileRequested: false,
        query: "query",
        role: "MEMORY_RERANK"
      },
      new AbortController().signal
    )).rejects.toThrow("memory_run_utility_runtime_invalid");
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
