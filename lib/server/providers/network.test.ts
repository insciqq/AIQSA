import { describe, expect, it } from "vitest";
import {
  ProviderResponseTooLargeError,
  providerResponseMaxBytes,
  readBoundedResponseText,
  timeoutError
} from "./network";

const encoder = new TextEncoder();

describe("provider network response bounds", () => {
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
