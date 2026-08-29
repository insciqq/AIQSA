import { describe, expect, it, vi } from "vitest";
import type { MemorySecretFreeExecutionSnapshot } from "../execution";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import {
  createAcceptedMemoryRunUtilityProvider,
  memoryRunUtilityProviderEvidence,
  MEMORY_AGGREGATION_TOOL_NAME,
  MEMORY_RERANK_TOOL_NAME
} from "./runUtilityRuntime";

const KEY = Buffer.alloc(32, 29);
const currentFactRerankCandidate = Object.freeze({
  directness: "DIRECT" as const,
  historical: false,
  lifecycleState: "ACTIVE" as const,
  temporalReason: "current" as const
});
const targetedCurrentRerank = Object.freeze({
  retrievalMode: "TARGETED_CURRENT" as const,
  temporalIntent: "CURRENT" as const
});

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
          "only as an ordering feature"
        );
        expect(JSON.stringify(body)).toContain(
          "compatibility metadata and do not control server admission"
        );
        expect(JSON.stringify(body)).toContain(
          "a candidate that contains that value and states the requested property is DIRECT_RELEVANCE"
        );
        expect(JSON.stringify(body)).toContain(
          "A different detail about the same project or event is usually NOT_RELEVANT"
        );
        expect(JSON.stringify(body)).toContain("temporal boundary");
        expect(JSON.stringify(body)).toContain('\\"profile_requested\\":false');
        expect(JSON.stringify(body)).not.toContain("SENSITIVE");
        if (adapterKind === "openrouter_chat_completions") {
          expect(new Headers(init?.headers).get("x-anthropic-beta"))
            .toContain("structured-outputs-2025-11-13");
          expect(body).toMatchObject({ reasoning: { exclude: true } });
          expect((body as Record<string, unknown>).reasoning)
            .not.toHaveProperty("enabled");
          expect((body as Record<string, unknown>).reasoning)
            .not.toHaveProperty("effort");
        }
        expect(body).toMatchObject(adapterKind === "openrouter_chat_completions"
          ? {
              max_tokens: 4_096,
              provider: { require_parameters: true },
              tool_choice: "required",
              tools: [{
                function: { name: MEMORY_RERANK_TOOL_NAME, strict: true },
                type: "function"
              }]
            }
          : {
              max_output_tokens: 4_096,
              text: { format: { strict: true, type: "json_schema" } }
            });
        return new Response(JSON.stringify(
          adapterKind === "openrouter_chat_completions"
            ? {
                choices: [{
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    role: "assistant",
                    tool_calls: [{
                      function: {
                        arguments: decision,
                        name: MEMORY_RERANK_TOOL_NAME
                      },
                      id: "call-1",
                      type: "function"
                    }]
                  }
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
      const baseAccepted = snapshot(adapterKind);
      const accepted: MemorySecretFreeExecutionSnapshot =
        adapterKind === "openrouter_chat_completions"
          ? {
              ...baseAccepted,
              providerExecutionSnapshot: {
                ...baseAccepted.providerExecutionSnapshot,
                model: {
                  ...baseAccepted.providerExecutionSnapshot.model,
                  capabilities: {
                    ...baseAccepted.providerExecutionSnapshot.model.capabilities,
                    defaultReasoningEffort: "high",
                    reasoning: true,
                    reasoningEfforts: ["high"]
                  },
                  defaultParams: {
                    reasoning: { enabled: true, effort: "high", exclude: true }
                  }
                }
              }
            }
          : baseAccepted;

      expect(accepted.providerExecutionSnapshot.model.capabilities)
        .not.toHaveProperty("structuredOutput");
      await expect(provider.run(
        memoryRunUtilityProviderEvidence(accepted),
        {
          ...targetedCurrentRerank,
          candidates: [{
            ...currentFactRerankCandidate,
            authorityLevel: "SAVED",
            current: true,
            handle: "c0",
            occurredFrom: null,
            occurredTo: null,
            sensitivityClass: "NORMAL",
            speakerScope: "memory_record" as const,
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

  it("serializes ordinary, profile, and aggregation requests distinctly", async () => {
    const fixture = client();
    const requestBodies: string[] = [];
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
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
      ...targetedCurrentRerank,
      candidates: [{
        ...currentFactRerankCandidate,
        authorityLevel: "SAVED" as const,
        current: true,
        handle: "c0",
        occurredFrom: null,
        occurredTo: null,
        sensitivityClass: "NORMAL" as const,
        speakerScope: "memory_record" as const,
        sourceKind: "FACT" as const,
        text: `The user's name is Nebula. Token ${token}`
      }],
      query: `What do you know about me? Token ${token}`,
      role: "MEMORY_RERANK" as const
    };

    await provider.run(
      evidence,
      { ...input, profileRequested: false },
      new AbortController().signal
    );
    await provider.run(
      evidence,
      { ...input, profileRequested: true, retrievalMode: "CURRENT_PROFILE" },
      new AbortController().signal
    );
    await provider.run(
      evidence,
      {
        ...input,
        aggregationRequested: true,
        profileRequested: false,
        retrievalMode: "PAST_CHAT_SEARCH",
        temporalIntent: "ANY"
      },
      new AbortController().signal
    );

    expect(requestBodies).toHaveLength(3);
    expect(requestBodies.join("\n")).not.toContain(token);
    expect(requestBodies.join("\n")).toContain("REDACTED");
    expect(requestBodies[0]).toContain('\\"profile_requested\\":false');
    expect(requestBodies[0]).toContain('\\"aggregation_requested\\":false');
    expect(requestBodies[0]).toContain("Cross-language paraphrases count as direct relevance");
    expect(requestBodies[0]).toContain("Как меня зовут?");
    expect(requestBodies[1]).toContain('\\"profile_requested\\":true');
    expect(requestBodies[1]).not.toBe(requestBodies[0]);
    expect(requestBodies[2]).toContain('\\"aggregation_requested\\":true');
    expect(requestBodies[2]).toContain(
      "retain each distinct applicable source needed to combine the answer"
    );
  });

  it("uses a distinct global evidence-planning contract for bounded aggregation", async () => {
    const fixture = client();
    const output = JSON.stringify({
      groups: [{
        item_handles: ["i0"],
        occurrence: "release Alpha",
        quantity: 1,
        quantity_evidence: "release Alpha",
        role: "MEMBER"
      }, {
        item_handles: ["i1"],
        occurrence: "launch day",
        quantity: 0,
        quantity_evidence: null,
        role: "BOUNDARY"
      }],
      operation: "COUNT",
      resolution: "PARTIAL"
    });
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      expect(JSON.stringify(body)).toContain("one MEMBER group for each distinct");
      expect(JSON.stringify(body)).toContain("explicitly states a cardinality");
      expect(JSON.stringify(body)).toContain("quantity_evidence");
      expect(JSON.stringify(body)).toContain("MEMBER_AND_BOUNDARY");
      expect(JSON.stringify(body)).toContain(
        "previous response for this exact evidence shard was rejected"
      );
      expect(JSON.stringify(body)).toContain(
        "repair schema intentionally permits only quantity 0 or 1"
      );
      expect(JSON.stringify(body)).toContain(
        "Never use a date, identifier, list position, rate, duration"
      );
      expect(JSON.stringify(body)).toContain("release Alpha");
      expect(body).toMatchObject({
        max_output_tokens: 4_096,
        reasoning: { effort: "low" },
        text: {
          format: {
            name: MEMORY_AGGREGATION_TOOL_NAME,
            schema: {
              properties: {
                groups: {
                  items: {
                    properties: {
                      quantity: { maximum: 1, minimum: 0, type: "integer" }
                    }
                  }
                },
                resolution: {
                  enum: ["AMBIGUOUS", "NOT_APPLICABLE", "PARTIAL"]
                }
              }
            },
            strict: true,
            type: "json_schema"
          }
        }
      });
      return new Response(JSON.stringify({
        id: "response-aggregation",
        output: [{
          content: [{ text: output, type: "output_text" }],
          id: "message-aggregation",
          role: "assistant",
          status: "completed",
          type: "message"
        }],
        status: "completed",
        usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 }
      }));
    });
    const provider = createAcceptedMemoryRunUtilityProvider(fixture.client, {
      createFetch: () => fetchFn,
      encryptionKey: () => KEY
    });

    await expect(provider.run(
      memoryRunUtilityProviderEvidence(snapshot("openai_responses_compatible")),
      {
        aggregationPhase: "MAP",
        completeEvidenceView: true,
        evidence: [{
          handle: "i0",
          occurredFrom: "2026-01-01T00:00:00.000Z",
          occurredTo: null,
          sourceKind: "HISTORY",
          text: "The user completed release Alpha."
        }, {
          handle: "i1",
          occurredFrom: "2026-02-01T00:00:00.000Z",
          occurredTo: null,
          sourceKind: "HISTORY",
          text: "The user described launch day."
        }],
        kind: "AGGREGATE",
        query: "How many releases happened before launch day?",
        repairReason: "QUANTITY_MISMATCH",
        role: "MEMORY_AGGREGATE"
      },
      new AbortController().signal
    )).resolves.toMatchObject({
      providerResponseId: "response-aggregation",
      toolCalls: [{ name: MEMORY_AGGREGATION_TOOL_NAME }],
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
    });
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
        ...targetedCurrentRerank,
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
        ...targetedCurrentRerank,
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
