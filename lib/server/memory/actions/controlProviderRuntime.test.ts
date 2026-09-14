import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_ACTION_INTENT_NAME } from "../../../contracts/memoryActionIntent";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { createAcceptedMemoryControlProvider } from "./controlRuntime";
import { buildMemoryActionIntentRequest } from "./intentService";

const { fetchProvider } = vi.hoisted(() => ({ fetchProvider: vi.fn<typeof fetch>() }));
const KEY = Buffer.alloc(32, 31);

vi.mock("../../secrets/envelope", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../secrets/envelope")>(),
  getSecretEncryptionKey: () => KEY
}));

vi.mock("../../providers/providerSafeFetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../providers/providerSafeFetch")>(),
  createProviderSafeFetch: () => fetchProvider
}));

function snapshot(chat = false): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Synthetic compatible provider",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind: chat ? "openai_chat_completions_compatible" : "openai_responses_compatible",
      answerSelectable: true,
      capabilities: {
        defaultMaxOutputTokens: 4_096,
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: true,
        streaming: false,
        toolCalling: true,
        vision: false
      },
      defaultParams: { reasoning: { effort: "medium" } },
      modelClass: "answer",
      upstreamModelId: "synthetic-control-model"
    },
    modelDisplayName: "Synthetic control model",
    providerFamily: "openai_compatible",
    providerModelId: "deployment-1",
    version: 1
  };
}

async function dispatch(runtime: ProviderExecutionSnapshot) {
  const before = JSON.stringify(runtime);
  const authenticated = runtime.connection.authenticationMode !== "none";
  const queryRaw = vi.fn(async () => [{
    credentialId: "credential-1", id: "credential-version-1", revokedAt: null,
    secretEnvelope: authenticated ? encryptProviderCredentialSecret({
      credentialId: "credential-1", valueId: "credential-version-1",
      key: KEY, secret: "synthetic-control-provider-secret"
    }) : null,
    testEvidence: { authenticationMode: authenticated ? "bearer" : "none" }
  }]);
  const provider = createAcceptedMemoryControlProvider({
    $transaction: async (callback: (tx: { $queryRaw: typeof queryRaw }) => Promise<unknown>) =>
      callback({ $queryRaw: queryRaw })
  } as never);
  const result = await provider.run({
    connectionId: runtime.connectionId,
    credentialId: runtime.credentialId!,
    credentialVersionId: runtime.credentialVersionId!,
    executionSnapshot: runtime,
    providerModelId: runtime.providerModelId
  }, buildMemoryActionIntentRequest({
    capabilities: { automaticLearning: true, historyRecall: true, memoryEnabled: true },
    currentUserMessage: "今日は庭で本を読みました。",
    memoryRefs: [],
    recentMessages: []
  }), new AbortController().signal);
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls?.[0]?.name).toBe(MEMORY_ACTION_INTENT_NAME);
  expect(queryRaw).toHaveBeenCalledOnce();
  expect(fetchProvider).toHaveBeenCalledOnce();
  expect(JSON.stringify(runtime)).toBe(before);
  const [, init] = fetchProvider.mock.calls[0]!;
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    model: "synthetic-control-model", stream: false,
    tool_choice: "required"
  });
  if (runtime.model.adapterKind === "openrouter_chat_completions") {
    expect(body).not.toHaveProperty("parallel_tool_calls");
  } else {
    expect(body.parallel_tool_calls).toBe(false);
  }
  return body;
}

beforeEach(() => {
  fetchProvider.mockReset();
  fetchProvider.mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const args = JSON.stringify({
      action: "NONE", answerRequested: true, category: null, confidenceBand: "HIGH",
      patternExclusionRequested: false, reasonCode: "no_memory_request",
      referencedMemoryRef: null, replacementStatement: null, responsePreference: false,
      sensitivity: "NORMAL", statement: null, targetQuery: null, thisChatOnly: false
    });
    return new Response(JSON.stringify(body.messages ? {
      id: "response-1",
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call-1", type: "function", function: {
          name: MEMORY_ACTION_INTENT_NAME, arguments: args
        } }]
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    } : {
      id: "response-1", status: "completed",
      output: [{ type: "function_call", id: "item-1", call_id: "call-1",
        name: MEMORY_ACTION_INTENT_NAME, arguments: args, status: "completed" }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }), { headers: { "content-type": "application/json" } });
  });
});

describe("Memory control provider request", () => {
  it.each([false, true])("preserves accepted effort without a raw capability list (chat=%s)", async (chat) => {
    const body = await dispatch(snapshot(chat));
    expect(chat ? body.reasoning_effort : body.reasoning?.effort).toBe("medium");
  });

  it.each([false, true])("preserves accepted effort when low is also supported (chat=%s)", async (chat) => {
    const runtime = snapshot(chat);
    runtime.model.capabilities.reasoningEfforts = ["low", "medium", "high"];
    runtime.model.capabilities.defaultReasoningEffort = "medium";
    const body = await dispatch(runtime);
    expect(chat ? body.reasoning_effort : body.reasoning?.effort).toBe("medium");
  });

  it.each([false, true])("preserves an explicit effort restriction (chat=%s)", async (chat) => {
    const runtime = snapshot(chat);
    runtime.model.capabilities.reasoningEfforts = ["medium", "high"];
    runtime.model.capabilities.defaultReasoningEffort = "medium";
    const body = await dispatch(runtime);
    expect(chat ? body.reasoning_effort : body.reasoning?.effort).toBe("medium");
  });

  it("does not override accepted defaults when reasoning capability is disabled", async () => {
    const runtime = snapshot();
    runtime.model.capabilities.reasoning = false;
    const body = await dispatch(runtime);
    expect(body.reasoning?.effort).toBe("medium");
  });

  it("uses the accepted custom parameter mapping for the control effort", async () => {
    const runtime = snapshot();
    if (runtime.model.adapterKind === "fake") throw new Error("invalid_fixture");
    runtime.model.reasoningRequestMapping = { effortPath: "generation.effort" };
    const body = await dispatch(runtime);
    expect(body.generation).toEqual({ effort: "medium" });
    expect(body).not.toHaveProperty("reasoning");
  });

  it("preserves accepted OpenRouter reasoning instead of silently disabling it", async () => {
    const base = snapshot(true);
    if (base.model.adapterKind === "fake") throw new Error("invalid_fixture");
    const runtime: ProviderExecutionSnapshot = {
      ...base,
      providerFamily: "openrouter",
      connection: { ...base.connection, authenticationMode: "bearer" },
      model: {
        ...base.model,
        adapterKind: "openrouter_chat_completions",
        defaultParams: { reasoning: { enabled: true, effort: "medium" } },
        openRouterRouting: { mode: "only_selected", providers: ["selected-route"] }
      }
    };
    const body = await dispatch(runtime);
    expect(body.reasoning).toMatchObject({ enabled: true, effort: "medium" });
    expect(body.provider).toMatchObject({
      only: ["selected-route"], allow_fallbacks: false, data_collection: "deny"
    });
  });
});
