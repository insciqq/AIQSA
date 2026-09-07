import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedOpenSearchCoreTransport } from "./coreTransport";

const request = {
  maximumResponseBytes: 1_024,
  method: "POST" as const,
  path: "_search",
  timeoutMs: 100
};

function transport(namespace: "knowledge" | "memory" = "knowledge") {
  return new BoundedOpenSearchCoreTransport({
    env: { AIQSA_OPENSEARCH_URL: "http://search.example.test:9200" },
    namespace
  });
}

function pendingFetch() {
  return vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared OpenSearch cancellation", () => {
  it.each(["knowledge", "memory"] as const)("does not dispatch an already cancelled %s request", async (namespace) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ hits: [] }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reason = new Error("operation_cancelled");
    controller.abort(reason);

    await expect(transport(namespace).request({ ...request, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request with the caller's cancellation reason", async () => {
    vi.useFakeTimers();
    const fetch = pendingFetch();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reason = new Error("operation_cancelled");
    const result = transport().request({ ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);

    controller.abort(reason);

    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the transport deadline distinct from caller cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", pendingFetch());
    const result = transport().request(request);
    const rejected = expect(result).rejects.toMatchObject({
      code: "opensearch_timeout", timedOut: true
    });

    await vi.advanceTimersByTimeAsync(request.timeoutMs);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reclassify cancellation while the network request is settling", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (reason: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })));
    const controller = new AbortController();
    const reason = new Error("operation_cancelled");
    const result = transport().request({ ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(request.timeoutMs);
    rejectFetch(reason);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases cancellation and deadline hooks after a successful response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ hits: [] }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(transport().request({ ...request, signal: controller.signal }))
      .resolves.toMatchObject({ body: { hits: [] }, status: 200 });
    controller.abort(new Error("operation_cancelled"));
    await vi.advanceTimersByTimeAsync(request.timeoutMs);

    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
