import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAIResponsesLifecycle,
  type OpenAIResponsesLifecycle,
  type OpenAIResponsesLifecycleObservation,
  type OpenAIResponsesLifecycleResult
} from "./openaiResponsesLifecycle";
import {
  createFetchOpenAIResponsesClient,
  type OpenAIResponseObject,
  type OpenAIResponsesClient
} from "./openaiResponsesTransport";

function client(overrides: Partial<OpenAIResponsesClient> = {}): OpenAIResponsesClient {
  return {
    cancel: async (responseId) => ({ id: responseId, status: "cancelled" }),
    create: async () => ({ id: "resp-default", status: "completed" }),
    retrieve: async (responseId) => ({ id: responseId, status: "completed" }),
    ...overrides
  };
}

async function collectLifecycle(
  generator: ReturnType<OpenAIResponsesLifecycle["createAndPoll"]>
): Promise<{
  observations: OpenAIResponsesLifecycleObservation[];
  result: OpenAIResponsesLifecycleResult;
}> {
  const observations: OpenAIResponsesLifecycleObservation[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return {
        observations,
        result: next.value
      };
    }
    observations.push(next.value);
  }
}

async function transportError(status: number): Promise<unknown> {
  const transport = createFetchOpenAIResponsesClient({
    apiKey: "key",
    fetchFn: async () => new Response(JSON.stringify({ error: { message: `status-${status}` } }), { status })
  });

  try {
    await transport.retrieve("resp-error");
  } catch (error) {
    return error;
  }

  throw new Error("expected_transport_error");
}

function afterDelay<T>(
  delayMs: number,
  signal: AbortSignal | undefined,
  operation: () => T | Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      Promise.resolve().then(operation).then(resolve, reject);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenAI Responses lifecycle", () => {
  it("emits the created response and completes immediately without retrieving", async () => {
    const controller = new AbortController();
    let createSignal: AbortSignal | undefined;
    let retrieveCalls = 0;
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async (_body, options) => {
          createSignal = options?.signal;
          return { id: "resp-complete", status: "completed" };
        },
        retrieve: async () => {
          retrieveCalls += 1;
          return {};
        }
      }),
      pollIntervalMs: 0
    });

    const collected = await collectLifecycle(
      lifecycle.createAndPoll({ model: "gpt-test" }, { signal: controller.signal })
    );

    expect(createSignal).not.toBe(controller.signal);
    expect(createSignal?.aborted).toBe(false);
    expect(retrieveCalls).toBe(0);
    expect(collected).toEqual({
      observations: [
        {
          kind: "created",
          response: { id: "resp-complete", status: "completed" }
        }
      ],
      result: {
        providerResponseId: "resp-complete",
        response: { id: "resp-complete", status: "completed" }
      }
    });
  });

  it("preserves poll attempts, retry observations, and retry-counter resets", async () => {
    const retryable = await transportError(503);
    const retrieved: Array<OpenAIResponseObject | unknown> = [
      retryable,
      { id: "resp-poll", status: "in_progress" },
      retryable,
      { id: "resp-poll", status: "completed" }
    ];
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => ({ id: "resp-poll", status: "queued" }),
        retrieve: async () => {
          const next = retrieved.shift();
          if (next === retryable) {
            throw next;
          }
          return next as OpenAIResponseObject;
        }
      }),
      maxPolls: 4,
      maxRetryableRetrieveErrors: 1,
      pollIntervalMs: 0
    });

    const collected = await collectLifecycle(lifecycle.createAndPoll({}));

    expect(collected.observations.map(({ kind }) => kind)).toEqual([
      "created",
      "retrieve_retry",
      "retrieved",
      "retrieve_retry",
      "retrieved"
    ]);
    expect(collected.observations[1]).toMatchObject({
      attempt: 1,
      error: { retryable: true, status: 503 },
      kind: "retrieve_retry"
    });
    expect(collected.observations[2]).toMatchObject({ attempt: 2, kind: "retrieved" });
    expect(collected.observations[3]).toMatchObject({ attempt: 3, kind: "retrieve_retry" });
    expect(collected.observations[4]).toMatchObject({ attempt: 4, kind: "retrieved" });
    expect(collected.result).toEqual({
      providerResponseId: "resp-poll",
      response: { id: "resp-poll", status: "completed" }
    });
  });

  it("throws the next consecutive retryable error after the configured retry budget", async () => {
    const retryable = await transportError(503);
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => ({ id: "resp-retry-budget", status: "queued" }),
        retrieve: async () => {
          throw retryable;
        }
      }),
      maxPolls: 5,
      maxRetryableRetrieveErrors: 1,
      pollIntervalMs: 0
    });
    const generator = lifecycle.createAndPoll({});

    await expect(generator.next()).resolves.toMatchObject({ value: { kind: "created" } });
    await expect(generator.next()).resolves.toMatchObject({
      value: { attempt: 1, kind: "retrieve_retry" }
    });
    await expect(generator.next()).rejects.toBe(retryable);
  });

  it("uses one captured deadline across slow create, waits, retry, and retrieve work", async () => {
    const retryable = await transportError(503);
    const previousTimeout = process.env.AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS;
    process.env.AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = "100";
    let retrieveCalls = 0;
    vi.useFakeTimers();

    try {
      const lifecycle = createOpenAIResponsesLifecycle({
        client: client({
          create: async (_body, options) =>
            afterDelay(25, options?.signal, () => ({ id: "resp-timeout", status: "queued" })),
          retrieve: async (_responseId, options) => {
            retrieveCalls += 1;
            return afterDelay(20, options?.signal, () => {
              if (retrieveCalls === 1) {
                throw retryable;
              }
              return { id: "resp-timeout", status: "in_progress" };
            });
          }
        }),
        maxRetryableRetrieveErrors: 1,
        pollIntervalMs: 20
      });
      process.env.AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = "1000";
      const generator = lifecycle.createAndPoll({});

      const created = generator.next();
      await vi.advanceTimersByTimeAsync(25);
      await expect(created).resolves.toMatchObject({ value: { kind: "created" } });

      const retry = generator.next();
      await vi.advanceTimersByTimeAsync(40);
      await expect(retry).resolves.toMatchObject({
        value: { attempt: 1, kind: "retrieve_retry" }
      });

      const expired = generator.next();
      const expiration = expect(expired).rejects.toThrow("openai_background_response_poll_timeout");
      await vi.advanceTimersByTimeAsync(35);
      await expiration;
      expect(retrieveCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (typeof previousTimeout === "undefined") {
        delete process.env.AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS;
      } else {
        process.env.AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("bounds a create client that ignores the lifecycle abort signal", async () => {
    vi.useFakeTimers();
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => new Promise<OpenAIResponseObject>(() => undefined)
      }),
      pollTimeoutMs: 50
    });
    const pending = lifecycle.createAndPoll({}).next();
    const expiration = expect(pending).rejects.toThrow("openai_background_response_poll_timeout");

    await vi.advanceTimersByTimeAsync(50);

    await expiration;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the deadline timer and caller listener when the generator returns early", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => ({ id: "resp-return", status: "queued" })
      }),
      pollTimeoutMs: 60_000
    });
    const generator = lifecycle.createAndPoll({}, { signal: controller.signal });

    await expect(generator.next()).resolves.toMatchObject({ value: { kind: "created" } });
    await generator.return({ providerResponseId: "resp-return", response: {} });

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects a pending response without an id after emitting its created observation", async () => {
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => ({ status: "queued" })
      }),
      pollIntervalMs: 0
    });
    const generator = lifecycle.createAndPoll({});

    await expect(generator.next()).resolves.toMatchObject({ value: { kind: "created" } });
    await expect(generator.next()).rejects.toThrow("openai_background_response_not_terminal");
  });

  it.each([
    ["missing", { id: "resp-missing" }],
    ["unknown", { id: "resp-unknown", status: "future_status" }]
  ])("rejects %s statuses without exact terminal proof", async (_label, response) => {
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({ create: async () => response }),
      pollIntervalMs: 0
    });
    const generator = lifecycle.createAndPoll({});

    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { kind: "created", response }
    });
    await expect(generator.next()).rejects.toThrow("openai_background_response_not_terminal");
  });

  it("classifies caller cancellation separately while a retrieve ignores abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let retrieveCalls = 0;
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        create: async () => ({ id: "resp-abort", status: "queued" }),
        retrieve: async () => {
          retrieveCalls += 1;
          return new Promise<OpenAIResponseObject>(() => undefined);
        }
      }),
      pollIntervalMs: 0,
      pollTimeoutMs: 60_000
    });
    const generator = lifecycle.createAndPoll({}, { signal: controller.signal });

    await generator.next();
    const pendingPoll = generator.next();
    await Promise.resolve();
    controller.abort();

    await expect(pendingPoll).rejects.toMatchObject({
      message: "provider_run_aborted",
      name: "AbortError"
    });
    expect(retrieveCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delegates cancel, retrieve, refresh, and stream while preserving their signal contract", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    let streamSignal: AbortSignal | undefined;
    const streamResponse = new Response("stream-body", { status: 200 });
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        cancel: async (responseId) => {
          calls.push(`cancel:${responseId}`);
          return { id: responseId, status: "cancelled" };
        },
        retrieve: async (responseId) => {
          calls.push(`retrieve:${responseId}`);
          return { id: responseId, status: "completed" };
        },
        stream: async (_body, options) => {
          calls.push("stream");
          streamSignal = options?.signal;
          return streamResponse;
        }
      })
    });

    await expect(lifecycle.cancel("resp-cancel")).resolves.toEqual({
      id: "resp-cancel",
      status: "cancelled"
    });
    await expect(lifecycle.retrieve("resp-retrieve")).resolves.toEqual({
      id: "resp-retrieve",
      status: "completed"
    });
    await expect(lifecycle.refresh("resp-refresh")).resolves.toEqual({
      kind: "response",
      response: { id: "resp-refresh", status: "completed" }
    });
    await expect(lifecycle.openStream({}, { signal: controller.signal })).resolves.toBe(streamResponse);
    expect(streamSignal).toBe(controller.signal);
    expect(calls).toEqual([
      "cancel:resp-cancel",
      "retrieve:resp-retrieve",
      "retrieve:resp-refresh",
      "stream"
    ]);
  });

  it("returns retryable refresh outcomes and rethrows non-retryable errors", async () => {
    const retryable = await transportError(503);
    const nonRetryable = await transportError(401);
    const errors = [retryable, nonRetryable];
    const lifecycle = createOpenAIResponsesLifecycle({
      client: client({
        retrieve: async () => {
          throw errors.shift();
        }
      })
    });

    await expect(lifecycle.refresh("resp-retry")).resolves.toMatchObject({
      error: { retryable: true, status: 503 },
      kind: "retry"
    });
    await expect(lifecycle.refresh("resp-fail")).rejects.toBe(nonRetryable);
  });

  it("fails explicitly when streaming is requested from a client without stream support", async () => {
    const lifecycle = createOpenAIResponsesLifecycle({ client: client() });

    await expect(lifecycle.openStream({ stream: true })).rejects.toThrow(
      "openai_streaming_client_not_available"
    );
  });
});
