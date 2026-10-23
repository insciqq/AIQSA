import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";

const bindingMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/runtimeFactory", async (importOriginal) => ({
  ...await importOriginal<typeof import("../providers/runtimeFactory")>(),
  createProviderRuntimeBinding: bindingMock
}));

import { createAcceptedProviderRequestExecutor } from "./acceptedRequestExecutor";

const key = Buffer.alloc(32, 7);

function snapshot(): ProviderExecutionSnapshot {
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
        vision: true
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

function request(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "internal-request",
    content: { blocks: [{ text: "bounded", type: "text" }] },
    forceNonStreaming: true,
    modelCapabilities: snapshot().model.capabilities,
    modelId: "gpt-test",
    params: { stream: false },
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

function result(): ProviderRunResult {
  return {
    finalProviderResponsePreview: {},
    finalText: "settled",
    usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }
  };
}

describe("accepted provider request executor", () => {
  beforeEach(() => {
    bindingMock.mockReset();
  });

  it("rechecks and decrypts the exact credential version at the network boundary", async () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key,
      secret: "private-test-secret",
      valueId: "credential-version-1"
    });
    const query = vi.fn(async () => [{
      credentialId: "credential-1",
      id: "credential-version-1",
      revokedAt: null,
      secretEnvelope: envelope,
      testEvidence: { authenticationMode: "bearer" }
    }]);
    const transaction = vi.fn(async (operation) => operation({ $queryRaw: query }));
    bindingMock.mockImplementation(({ secret }) => ({
      adapter: {
        async *stream() {
          expect(await secret()).toBe("private-test-secret");
          return result();
        }
      }
    }));
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), request())).resolves.toMatchObject({ finalText: "settled" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });

  it("fails closed when the pinned credential version was revoked", async () => {
    const transaction = vi.fn(async (operation) => operation({
      $queryRaw: async () => [{
        credentialId: "credential-1",
        id: "credential-version-1",
        revokedAt: new Date(),
        secretEnvelope: "unused",
        testEvidence: { authenticationMode: "bearer" }
      }]
    }));
    bindingMock.mockImplementation(({ secret }) => ({
      adapter: {
        async *stream() {
          await secret();
          return result();
        }
      }
    }));
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), request())).rejects.toThrow("credential_revoked");
  });

  it("rejects streaming or tool-bearing requests before credential access", async () => {
    const transaction = vi.fn();
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => vi.fn<typeof fetch>(),
      encryptionKey: () => key
    });

    await expect(execute(snapshot(), {
      ...request(),
      forceNonStreaming: false
    })).rejects.toThrow("accepted_provider_request_invalid");
    expect(transaction).not.toHaveBeenCalled();
    expect(bindingMock).not.toHaveBeenCalled();
  });

  it("does not repeat a crash-ambiguous transport request when the consumer owns dispatch recovery", async () => {
    const actual = await vi.importActual<typeof import("../providers/runtimeFactory")>("../providers/runtimeFactory");
    bindingMock.mockImplementation(actual.createProviderRuntimeBinding);
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("synthetic connection lost after dispatch"));
    const transaction = vi.fn(async operation => operation({ $queryRaw: async () => [{
      credentialId: "credential-1", id: "credential-version-1", revokedAt: null,
      secretEnvelope: null, testEvidence: { authenticationMode: "none" }
    }] }));
    const accepted = snapshot();
    const execute = createAcceptedProviderRequestExecutor({
      $transaction: transaction
    } as unknown as Pick<PrismaClient, "$transaction">, {
      createFetch: () => fetchFn, disableRequestRetries: true
    });
    await expect(execute({ ...accepted,
      providerFamily: "openai_compatible",
      connection: { ...accepted.connection, allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:11434/v1", authenticationMode: "none" },
      model: { ...accepted.model, adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer" }
    }, { ...request(), provider: "openai_compatible" })).rejects.toThrow("synthetic connection lost after dispatch");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
  });

  describe("Codex LB dropped requests (Vision)", () => {
    const noAuth = vi.fn(async (operation) => operation({ $queryRaw: async () => [{
      credentialId: "credential-1", id: "credential-version-1", revokedAt: null,
      secretEnvelope: null, testEvidence: { authenticationMode: "none" }
    }] }));
    function compatible(apiRoot: string): ProviderExecutionSnapshot {
      const accepted = snapshot();
      return { ...accepted, providerFamily: "openai_compatible",
        connection: { ...accepted.connection, allowPrivateNetwork: true, apiRoot, authenticationMode: "none" },
        model: { ...accepted.model, adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer" } };
    }
    const codexLb = compatible("http://127.0.0.1:11434/backend-api/codex");
    const compatibleRequest = (): ProviderRunRequest => ({ ...request(), provider: "openai_compatible" });
    const gateway502 = () => new Response("PRIVATE_GATEWAY_BODY", { status: 502, headers: { "retry-after": "1" } });
    const completed = () => new Response(JSON.stringify({ id: "response-1", model: "gpt-test", output_text: "settled", status: "completed",
      usage: { input_tokens: 40, output_tokens: 6, total_tokens: 46 } }));
    /** `requestMs`: how long each request takes on the fake clock. */
    async function real(replies: readonly (() => Response)[], apiRoot?: string, requestMs = 0) {
      const actual = await vi.importActual<typeof import("../providers/runtimeFactory")>("../providers/runtimeFactory");
      bindingMock.mockImplementation(actual.createProviderRuntimeBinding);
      const clock = { now: 1_000_000 };
      let index = 0;
      const fetchFn = vi.fn<typeof fetch>(async () => {
        clock.now += requestMs;
        return replies[index++]!();
      });
      const sleeps: number[] = [];
      const usage: unknown[] = [];
      const execute = createAcceptedProviderRequestExecutor({ $transaction: noAuth } as unknown as Pick<PrismaClient, "$transaction">, {
        createFetch: () => fetchFn, disableRequestRetries: true,
        droppedRequestRetry: { now: () => clock.now, random: () => 0, sleep: async (delayMs) => {
          sleeps.push(delayMs);
          clock.now += delayMs;
        } }
      });
      const run = () => execute(apiRoot ? compatible(apiRoot) : codexLb, compatibleRequest(),
        { onUsage: (value) => usage.push(value) });
      return { fetchFn, run, sleeps, usage };
    }

    /** The production configuration: a bearer-auth codex-lb root, whose
     * non-streaming create the transport assembles from SSE. */
    async function bearer(replies: readonly (() => Response)[]) {
      const actual = await vi.importActual<typeof import("../providers/runtimeFactory")>("../providers/runtimeFactory");
      bindingMock.mockImplementation(actual.createProviderRuntimeBinding);
      const envelope = encryptProviderCredentialSecret({ credentialId: "credential-1", key, secret: "synthetic", valueId: "credential-version-1" });
      const transaction = vi.fn(async (operation) => operation({ $queryRaw: async () => [{
        credentialId: "credential-1", id: "credential-version-1", revokedAt: null,
        secretEnvelope: envelope, testEvidence: { authenticationMode: "bearer" }
      }] }));
      let index = 0;
      const fetchFn = vi.fn<typeof fetch>(async () => replies[index++]!());
      const sleeps: number[] = [];
      const execute = createAcceptedProviderRequestExecutor({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">, {
        createFetch: () => fetchFn, disableRequestRetries: true, encryptionKey: () => key,
        droppedRequestRetry: { random: () => 0, sleep: async (delayMs) => { sleeps.push(delayMs); } }
      });
      const accepted = compatible("https://lb.example.test/backend-api/codex");
      const run = () => execute({ ...accepted, connection: { ...accepted.connection, allowPrivateNetwork: false, authenticationMode: "bearer" } },
        compatibleRequest());
      return { fetchFn, run, sleeps };
    }
    const sse = (...events: readonly Record<string, unknown>[]) => () => new Response(
      events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
    const message = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PRIVATE_ANALYSIS" }] };
    const created = { type: "response.created", response: { id: "response-1", status: "in_progress" } };
    const added = { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } };
    const delta = { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PRIVATE_PART" };

    it.each([
      ["a completed output item", sse(created, { type: "response.output_item.done", output_index: 0, item: message })],
      ["a text delta", sse(created, { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PRIVATE_PART" })],
      ["a failed terminal carrying output", sse(created, { type: "response.failed",
        response: { id: "response-1", status: "failed", output: [message], error: { code: "server_error" } } })],
      ["a text delta, then a failed terminal without output", sse(created, added, delta, { type: "response.failed",
        response: { id: "response-1", status: "failed", output: [], error: { code: "server_error" } } })],
      ["a completed message, then a failed terminal carrying only reasoning", sse(created,
        { type: "response.output_item.done", output_index: 0, item: message }, { type: "response.failed",
          response: { id: "response-1", status: "failed", output: [{ type: "reasoning", summary: [] }], error: { code: "server_error" } } })],
      ["a text delta, then an incomplete terminal", sse(created, added, delta, { type: "response.incomplete",
        response: { id: "response-1", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } })],
      ["a text delta, then an error event", sse(created, added, delta, { type: "error", error: { code: "server_error" } })],
      ["a text delta, then [DONE] without a terminal", () => new Response(
        `event: response.created\ndata: ${JSON.stringify(created)}\n\n` +
          `data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })]
    ])("never sends again after the assembled stream delivered %s", async (_label, first) => {
      const call = await bearer([first, completed]);
      await call.run().catch(() => undefined);
      expect(call.fetchFn).toHaveBeenCalledOnce();
      expect(call.sleeps).toEqual([]);
    });

    it.each([
      ["a 502", gateway502],
      ["a stream that dropped before any output", sse(created, { type: "response.output_item.done", output_index: 0,
        item: { type: "reasoning", summary: [] } })],
      ["a stream that dropped after only reasoning summary progress", sse(created,
        { type: "response.reasoning_summary_part.added", item_id: "rs-1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "**Reading the image**" },
        { type: "response.reasoning_summary_text.done", item_id: "rs-1", output_index: 0, summary_index: 0, text: "**Reading the image**" })]
    ])("still sends again on the bearer-auth root after %s", async (_label, first) => {
      const call = await bearer([first, completed]);
      await expect(call.run()).resolves.toMatchObject({ finalText: "settled" });
      expect(call.fetchFn).toHaveBeenCalledTimes(2);
      expect(call.sleeps).toHaveLength(1);
    });

    it("sends a request that failed with 502 again inside the same call, accounting both", async () => {
      const call = await real([gateway502, completed]);
      const result = await call.run();
      expect(result.finalText).toBe("settled");
      expect(call.fetchFn).toHaveBeenCalledTimes(2);
      expect(call.sleeps).toEqual([1_000]);
      // The dropped request's usage is unknown, so the call's sum stays partial.
      expect(result.usage).toMatchObject({ completeness: "partial", inputTokens: 40, outputTokens: 6 });
      expect(call.usage.at(-1)).toEqual(result.usage);
    });

    it("rides out four 502s within the before-output window, accounting every request", async () => {
      const call = await real([gateway502, gateway502, gateway502, gateway502, completed]);
      const result = await call.run();
      expect(result.finalText).toBe("settled");
      expect(call.fetchFn).toHaveBeenCalledTimes(5);
      // About 2, 4 and 8 s at the jitter floor; a 1 s Retry-After never shortens them.
      expect(call.sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(result.usage).toMatchObject({ completeness: "partial", inputTokens: 40, outputTokens: 6 });
    });

    it("gives up when the next wait would end after the window", async () => {
      // Each 502 takes 30 s: the third fails at 93 s, past the 90 s window.
      const slow = await real([gateway502, gateway502, gateway502, gateway502, completed], undefined, 30_000);
      await expect(slow.run()).rejects.toMatchObject({ status: 502 });
      expect(slow.fetchFn).toHaveBeenCalledTimes(3);
      expect(slow.sleeps).toEqual([1_000, 2_000]);
      // Each dropped request was reported as its own operation.
      expect(slow.usage).toHaveLength(2);
    });

    it("gives up after the sixth dropped request and keeps other bindings to one request", async () => {
      const bounded = await real([gateway502, gateway502, gateway502, gateway502, gateway502, gateway502, completed]);
      await expect(bounded.run()).rejects.toMatchObject({ status: 502 });
      expect(bounded.fetchFn).toHaveBeenCalledTimes(6);
      expect(bounded.sleeps).toHaveLength(5);
      const other = await real([gateway502, completed], "http://127.0.0.1:11434/v1");
      await expect(other.run()).rejects.toMatchObject({ status: 502 });
      expect(other.fetchFn).toHaveBeenCalledOnce();
    });

    function dropping(events: readonly ("output" | "usage")[], drops: number) {
      const sends: number[] = [];
      const decision = vi.fn(() => ({ retryAfterMs: null }));
      bindingMock.mockImplementation(() => ({ adapter: {
        droppedRoundRetry: { decision, maxAttempts: 3, observe: vi.fn() },
        async *stream() {
          sends.push(sends.length + 1);
          for (const event of events) yield event === "usage"
            ? { data: { inputTokens: 9 }, type: "usage" as const }
            : { data: { delta: "PRIVATE_PARTIAL" }, type: "token" as const };
          if (sends.length <= drops) throw new Error("dropped");
          return result();
        }
      } }));
      return { decision, sends };
    }
    const executor = (sleep: (delayMs: number, signal: AbortSignal) => Promise<void> = async () => undefined) =>
      createAcceptedProviderRequestExecutor({ $transaction: noAuth } as unknown as Pick<PrismaClient, "$transaction">, {
        createFetch: () => vi.fn<typeof fetch>(), droppedRequestRetry: { random: () => 0, sleep } });

    it("never sends again once output of the request arrived", async () => {
      const drop = dropping(["output"], 1);
      await expect(executor()(codexLb, compatibleRequest())).rejects.toThrow("dropped");
      expect(drop.sends).toEqual([1]);
    });

    it("sums the reported usage of a dropped request with the request that answered", async () => {
      dropping(["usage"], 1);
      const reported: unknown[] = [];
      const answered = await executor()(codexLb, compatibleRequest(), { onUsage: (value) => reported.push(value) });
      expect(answered.usage).toMatchObject({ completeness: "partial", inputTokens: 11, outputTokens: 1, totalTokens: 3 });
    });

    it("ends without a re-send after Stop, during the request or the backoff", async () => {
      const stopped = new AbortController();
      stopped.abort();
      const before = dropping([], 1);
      await expect(executor()(codexLb, compatibleRequest(), { signal: stopped.signal })).rejects.toThrow("dropped");
      expect(before.sends).toEqual([1]);
      const controller = new AbortController();
      const during = dropping([], 1);
      await expect(executor(async () => {
        controller.abort(new Error("stopped"));
        throw controller.signal.reason;
      })(codexLb, compatibleRequest(), { signal: controller.signal })).rejects.toThrow("stopped");
      expect(during.sends).toEqual([1]);
    });
  });
});
