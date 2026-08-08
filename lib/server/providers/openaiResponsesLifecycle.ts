import { ProviderRequestTimeoutError } from "./network";
import { DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS } from "./openaiBackgroundPolling";
import {
  isTerminalOpenAIResponse,
  resolveOpenAIResponseIdentity,
  shouldPollOpenAIResponse
} from "./openaiResponsesResponse";
import {
  openAIRetryableErrorPayload,
  type OpenAIResponseObject,
  type OpenAIRetryableErrorPayload,
  type OpenAIResponsesClient,
  type OpenAIResponsesClientRequestOptions
} from "./openaiResponsesTransport";

export type OpenAIResponsesLifecycleOptions = {
  client: OpenAIResponsesClient;
  /** Optional deterministic/defensive cap; elapsed time owns the production lifecycle deadline. */
  maxPolls?: number;
  maxRetryableRetrieveErrors?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type OpenAIResponsesLifecycleObservation =
  | {
      kind: "created";
      response: OpenAIResponseObject;
    }
  | {
      attempt: number;
      kind: "retrieved";
      response: OpenAIResponseObject;
    }
  | {
      attempt: number;
      error: OpenAIRetryableErrorPayload;
      kind: "retrieve_retry";
    };

export type OpenAIResponsesLifecycleResult = {
  providerResponseId?: string;
  response: OpenAIResponseObject;
};

export type OpenAIResponsesRefreshOutcome =
  | {
      kind: "response";
      response: OpenAIResponseObject;
    }
  | {
      error: OpenAIRetryableErrorPayload;
      kind: "retry";
    };

export type OpenAIResponsesLifecycle = {
  cancel(responseId: string): Promise<OpenAIResponseObject>;
  createAndPoll(
    body: OpenAIResponseObject,
    options?: OpenAIResponsesClientRequestOptions
  ): AsyncGenerator<OpenAIResponsesLifecycleObservation, OpenAIResponsesLifecycleResult>;
  openStream(body: OpenAIResponseObject, options?: OpenAIResponsesClientRequestOptions): Promise<Response>;
  refresh(responseId: string): Promise<OpenAIResponsesRefreshOutcome>;
  retrieve(responseId: string): Promise<OpenAIResponseObject>;
};

const defaultPollIntervalMs = 1000;

function abortError(): Error {
  const error = new Error("provider_run_aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type LifecycleInterruption = "caller" | "timeout";

class OpenAIBackgroundDeadline {
  private interruption?: LifecycleInterruption;
  private interruptionError?: Error;
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly interrupted: Promise<void>;
  private readonly timeoutMs: number;
  private resolveInterrupted!: () => void;
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(
    timeoutMs: number,
    private readonly callerSignal?: AbortSignal
  ) {
    const boundedTimeoutMs = Math.max(0, timeoutMs);
    this.timeoutMs = boundedTimeoutMs;
    this.expiresAt = performance.now() + boundedTimeoutMs;
    this.interrupted = new Promise((resolve) => {
      this.resolveInterrupted = resolve;
    });

    if (callerSignal?.aborted) {
      this.interrupt("caller");
      return;
    }

    callerSignal?.addEventListener("abort", this.handleCallerAbort, { once: true });
    this.timeout = setTimeout(() => this.interrupt("timeout"), boundedTimeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private readonly handleCallerAbort = () => this.interrupt("caller");

  private detachCallerSignal() {
    this.callerSignal?.removeEventListener("abort", this.handleCallerAbort);
  }

  private interrupt(kind: LifecycleInterruption) {
    if (this.interruption) {
      return;
    }

    this.interruption = kind;
    const callerReason = this.callerSignal?.reason;
    this.interruptionError = kind === "timeout"
      ? new ProviderRequestTimeoutError(this.timeoutMs)
      : callerReason instanceof Error && callerReason.name !== "AbortError"
        ? callerReason
        : abortError();
    if (typeof this.timeout !== "undefined") {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.detachCallerSignal();
    this.controller.abort(this.interruptionError);
    this.resolveInterrupted();
  }

  private expireIfElapsed() {
    if (!this.interruption && performance.now() >= this.expiresAt) {
      this.interrupt("timeout");
    }
  }

  throwIfInterrupted() {
    this.expireIfElapsed();
    if (this.interruptionError) {
      throw this.interruptionError;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfInterrupted();
    const pending = Promise.resolve().then(operation);

    try {
      const outcome = await Promise.race([
        pending.then((value) => ({ kind: "value" as const, value })),
        this.interrupted.then(() => ({ kind: "interrupted" as const }))
      ]);

      if (outcome.kind === "interrupted") {
        throw this.interruptionError;
      }

      this.throwIfInterrupted();
      return outcome.value;
    } catch (error) {
      this.expireIfElapsed();
      if (this.interruptionError) {
        throw this.interruptionError;
      }
      throw error;
    }
  }

  clear() {
    if (typeof this.timeout !== "undefined") {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.detachCallerSignal();
  }
}

export function createOpenAIResponsesLifecycle(options: OpenAIResponsesLifecycleOptions): OpenAIResponsesLifecycle {
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS;
  const maxRetryableRetrieveErrors = options.maxRetryableRetrieveErrors ?? 5;

  return {
    async cancel(providerResponseId) {
      const response = await options.client.cancel(providerResponseId);
      resolveOpenAIResponseIdentity(response, providerResponseId);
      return response;
    },
    async *createAndPoll(body, requestOptions = {}) {
      const deadline = new OpenAIBackgroundDeadline(pollTimeoutMs, requestOptions.signal);

      try {
        let response = await deadline.run(() => options.client.create(body, {
          signal: deadline.signal,
          ...(typeof requestOptions.timeoutMs === "number"
            ? { timeoutMs: requestOptions.timeoutMs }
            : {})
        }));
        const providerResponseId = resolveOpenAIResponseIdentity(response);

        deadline.throwIfInterrupted();
        yield {
          kind: "created",
          response
        };

        let pollCount = 0;
        let retryableRetrieveErrors = 0;
        while (providerResponseId && shouldPollOpenAIResponse(response)) {
          deadline.throwIfInterrupted();
          if (typeof options.maxPolls === "number" && pollCount >= options.maxPolls) {
            throw new Error("openai_background_response_poll_timeout");
          }

          if (pollIntervalMs > 0) {
            await deadline.run(() => wait(pollIntervalMs, deadline.signal));
          }

          pollCount += 1;
          try {
            response = await deadline.run(() =>
              options.client.retrieve(providerResponseId, {
                signal: deadline.signal,
                ...(typeof requestOptions.timeoutMs === "number"
                  ? { timeoutMs: requestOptions.timeoutMs }
                  : {})
              })
            );
            resolveOpenAIResponseIdentity(response, providerResponseId);
            retryableRetrieveErrors = 0;
          } catch (error) {
            const retryable = openAIRetryableErrorPayload(error);
            if (!retryable || retryableRetrieveErrors >= maxRetryableRetrieveErrors) {
              throw error;
            }

            retryableRetrieveErrors += 1;
            yield {
              attempt: pollCount,
              error: retryable,
              kind: "retrieve_retry"
            };
            continue;
          }

          deadline.throwIfInterrupted();
          yield {
            attempt: pollCount,
            kind: "retrieved",
            response
          };
        }

        if (!isTerminalOpenAIResponse(response)) {
          throw new Error("openai_background_response_not_terminal");
        }

        return {
          providerResponseId,
          response
        };
      } finally {
        deadline.clear();
      }
    },
    async openStream(body, requestOptions = {}) {
      if (!options.client.stream) {
        throw new Error("openai_streaming_client_not_available");
      }

      return options.client.stream(body, requestOptions);
    },
    async refresh(providerResponseId) {
      try {
        const response = await options.client.retrieve(providerResponseId);
        resolveOpenAIResponseIdentity(response, providerResponseId);
        return {
          kind: "response",
          response
        };
      } catch (error) {
        const retryable = openAIRetryableErrorPayload(error);
        if (!retryable) {
          throw error;
        }

        return {
          error: retryable,
          kind: "retry"
        };
      }
    },
    async retrieve(providerResponseId) {
      const response = await options.client.retrieve(providerResponseId);
      resolveOpenAIResponseIdentity(response, providerResponseId);
      return response;
    }
  };
}
