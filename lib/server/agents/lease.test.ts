import { afterEach, expect, it, vi } from "vitest";
import { withAgentLease } from "./lease";

afterEach(() => vi.useRealTimers());

it("aborts an in-flight request when another process revokes its grant", async () => {
  vi.useFakeTimers();
  let active = true;
  let upstreamSignal: AbortSignal | undefined;
  const response = await withAgentLease(new Request("http://agent.invalid"), async () => {
    if (!active) throw new Error("revoked");
  }, async (signal) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
    } }));
  });
  const reading = expect(response.text()).rejects.toThrow("agent_request_interrupted");
  active = false;
  await vi.advanceTimersByTimeAsync(1000);
  await reading;
  expect(upstreamSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("ends the stream without an error when the client inside the VM closes its own request", async () => {
  vi.useFakeTimers();
  const client = new AbortController();
  let upstreamSignal: AbortSignal | undefined;
  const response = await withAgentLease(new Request("http://agent.invalid", { signal: client.signal }), async () => {}, async (signal) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      signal.addEventListener("abort", () => controller.error(new Error("aborted upstream")), { once: true });
    } }));
  });
  const reading = response.text();
  await vi.advanceTimersByTimeAsync(0);
  client.abort();
  // A failed body would make Next log "failed to pipe response" and answer 500.
  await expect(reading).resolves.toBe("partial");
  expect(upstreamSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("still interrupts the stream as a failure when the upstream fails while the client waits", async () => {
  const response = await withAgentLease(new Request("http://agent.invalid"), async () => {}, async () =>
    new Response(new ReadableStream({ pull(controller) { controller.error(new Error("upstream failed")); } })));
  await expect(response.text()).rejects.toThrow("agent_request_interrupted");
});

it("releases its watchdog when the stream ends normally", async () => {
  vi.useFakeTimers();
  const response = await withAgentLease(new Request("http://agent.invalid"), async () => {}, async () => new Response("ok"));
  expect(await response.text()).toBe("ok");
  expect(vi.getTimerCount()).toBe(0);
});
