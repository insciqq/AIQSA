import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_STREAM_LIMITS,
  getProviderStreamLimits,
  isProviderDeadlineExceededError,
  PROVIDER_STREAM_LIMIT_CEILINGS,
  ProviderRequestTimeoutError,
  ProviderResponseTooLargeError,
  providerResponseMaxBytes,
  providerStreamIdleTimeoutMs,
  providerStreamTimingLimits,
  readBoundedResponseText,
  resolveProviderStreamLimits,
  timeoutError,
  withTimeoutSignal
} from "./network";

const encoder = new TextEncoder();

describe("provider network response bounds", () => {
  it("resolves independent provider-stream defaults", () => {
    expect(getProviderStreamLimits({})).toEqual(DEFAULT_PROVIDER_STREAM_LIMITS);
    expect(getProviderStreamLimits({})).toEqual({
      idleTimeoutMs: 300_000,
      maxBytes: 64 * 1024 * 1024,
      maxDurationMs: 300_000,
      maxEventBytes: 4 * 1024 * 1024,
      maxOutputChars: 8 * 1024 * 1024
    });
    expect(Object.isFrozen(getProviderStreamLimits({}))).toBe(true);
  });

  it("accepts each documented hard ceiling without environment-owned timing", () => {
    const environment = {
      AIQSA_PROVIDER_STREAM_MAX_BYTES: String(PROVIDER_STREAM_LIMIT_CEILINGS.maxBytes),
      AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES: String(PROVIDER_STREAM_LIMIT_CEILINGS.maxEventBytes),
      AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS: String(PROVIDER_STREAM_LIMIT_CEILINGS.maxOutputChars)
    };
    expect(resolveProviderStreamLimits({
      idleTimeoutMs: PROVIDER_STREAM_LIMIT_CEILINGS.idleTimeoutMs,
      maxDurationMs: PROVIDER_STREAM_LIMIT_CEILINGS.maxDurationMs
    }, environment)).toEqual(PROVIDER_STREAM_LIMIT_CEILINGS);
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    " 1",
    "9007199254740992",
    String(PROVIDER_STREAM_LIMIT_CEILINGS.maxBytes + 1)
  ])("falls back safely for invalid stream-limit value %j", (value) => {
    expect(getProviderStreamLimits({
      AIQSA_PROVIDER_STREAM_MAX_BYTES: value
    }).maxBytes).toBe(DEFAULT_PROVIDER_STREAM_LIMITS.maxBytes);
  });

  it("falls back independently and clamps event bytes to total stream bytes", () => {
    expect(getProviderStreamLimits({
      AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "-1",
      AIQSA_PROVIDER_STREAM_MAX_BYTES: "1024",
      AIQSA_PROVIDER_STREAM_MAX_DURATION_MS: "0",
      AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES: "2048",
      AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS: "1.5"
    })).toEqual({
      idleTimeoutMs: DEFAULT_PROVIDER_STREAM_LIMITS.idleTimeoutMs,
      maxBytes: 1024,
      maxDurationMs: DEFAULT_PROVIDER_STREAM_LIMITS.maxDurationMs,
      maxEventBytes: 1024,
      maxOutputChars: DEFAULT_PROVIDER_STREAM_LIMITS.maxOutputChars
    });
  });

  it("validates injected stream-limit overrides through the same ceilings and relationships", () => {
    expect(resolveProviderStreamLimits({
      idleTimeoutMs: 3,
      maxBytes: 7,
      maxDurationMs: 11,
      maxEventBytes: 9,
      maxOutputChars: 13
    }, {})).toEqual({
      idleTimeoutMs: 3,
      maxBytes: 7,
      maxDurationMs: 11,
      maxEventBytes: 7,
      maxOutputChars: 13
    });

    expect(resolveProviderStreamLimits({
      maxBytes: PROVIDER_STREAM_LIMIT_CEILINGS.maxBytes + 1,
      maxOutputChars: Number.POSITIVE_INFINITY
    }, {})).toEqual(DEFAULT_PROVIDER_STREAM_LIMITS);
  });

  it("ignores removed environment timing controls", () => {
    const previous = process.env.AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS;

    try {
      process.env.AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS = "1234";
      expect(providerStreamIdleTimeoutMs()).toBe(DEFAULT_PROVIDER_STREAM_LIMITS.idleTimeoutMs);

      process.env.AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS = String(
        PROVIDER_STREAM_LIMIT_CEILINGS.idleTimeoutMs + 1
      );
      expect(providerStreamIdleTimeoutMs()).toBe(DEFAULT_PROVIDER_STREAM_LIMITS.idleTimeoutMs);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env.AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
      } else {
        process.env.AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS = previous;
      }
    }
  });

  it("derives both stream timing guards from the response deadline", () => {
    expect(providerStreamTimingLimits(800_000)).toEqual({
      idleTimeoutMs: 800_000,
      maxDurationMs: 800_000
    });
  });

  it("emits a typed configured timeout and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const timeout = withTimeoutSignal(undefined, 5_000);
      const aborted = new Promise<unknown>((resolve) => {
        timeout.signal.addEventListener("abort", () => resolve(timeout.signal.reason), {
          once: true
        });
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(aborted).resolves.toMatchObject({
        code: "provider_request_timed_out",
        message: "Provider response exceeded the configured 5-second timeout.",
        timeoutMs: 5_000
      });
      expect(timeout.signal.reason).toBeInstanceOf(ProviderRequestTimeoutError);
      timeout.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer a configured deadline from names or message text", () => {
    expect(isProviderDeadlineExceededError(new ProviderRequestTimeoutError(5_000))).toBe(true);
    expect(isProviderDeadlineExceededError(new Error(
      "upstream connect error or disconnect/reset before headers: connection timeout"
    ))).toBe(false);
    expect(isProviderDeadlineExceededError(timeoutError())).toBe(false);
  });

  it("uses the 16 MiB default and accepts a positive environment override", () => {
    const previous = process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;

    try {
      delete process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
      expect(providerResponseMaxBytes()).toBe(16 * 1024 * 1024);

      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "1234";
      expect(providerResponseMaxBytes()).toBe(1234);

      process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "0";
      expect(providerResponseMaxBytes()).toBe(16 * 1024 * 1024);
    } finally {
      if (typeof previous === "undefined") {
        delete process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = previous;
      }
    }
  });

  it("decodes UTF-8 split across chunks while counting raw bytes", async () => {
    const bytes = encoder.encode("éé");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1, 3));
          controller.enqueue(bytes.slice(3));
          controller.close();
        }
      })
    );

    await expect(readBoundedResponseText(response, { maxBytes: 4 })).resolves.toBe("éé");
    expect(response.body?.locked).toBe(false);
  });

  it("cancels an oversized body and exposes a stable typed error", async () => {
    let cancellationReason: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationReason = reason;
        },
        start(controller) {
          controller.enqueue(encoder.encode("éé"));
        }
      })
    );

    let failure: unknown;
    try {
      await readBoundedResponseText(response, { maxBytes: 3 });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderResponseTooLargeError);
    expect(failure).toMatchObject({
      code: "provider_response_too_large",
      maxBytes: 3,
      message: "provider_response_too_large",
      name: "ProviderResponseTooLargeError",
      receivedBytes: 4
    });
    expect(cancellationReason).toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it("preserves an abort reason while cancelling and releasing a stalled reader", async () => {
    let cancellationReason: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationReason = reason;
        },
        pull() {
          // Keep the read pending until the supplied signal aborts it.
        }
      })
    );
    const controller = new AbortController();
    const reason = timeoutError("body_deadline_reached");
    const read = readBoundedResponseText(response, { signal: controller.signal });

    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
    expect(cancellationReason).toBe(reason);
    expect(response.body?.locked).toBe(false);

    const emptyBodyController = new AbortController();
    emptyBodyController.abort(reason);
    await expect(
      readBoundedResponseText(new Response(null), { signal: emptyBodyController.signal })
    ).rejects.toBe(reason);
  });
});
