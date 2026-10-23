import { afterEach, expect, it, vi } from "vitest";
import { RUNNER_GATEWAY_LEASE_CANCELLED, withRunnerGatewayLease } from "./runnerGatewayLease";

afterEach(() => vi.useRealTimers());

it("aborts an in-flight request when another process revokes its grant", async () => {
  vi.useFakeTimers();
  let active = true;
  let upstreamSignal: AbortSignal | undefined;
  const response = await withRunnerGatewayLease(new Request("http://agent.invalid"), async () => {
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
  const response = await withRunnerGatewayLease(new Request("http://agent.invalid", { signal: client.signal }), async () => {}, async (signal) => {
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

it("ends the stream without an error when the user stops the run", async () => {
  vi.useFakeTimers();
  let stopped = false;
  let upstreamSignal: AbortSignal | undefined;
  const response = await withRunnerGatewayLease(new Request("http://agent.invalid"), async () => {
    if (stopped) throw new Error(RUNNER_GATEWAY_LEASE_CANCELLED);
  }, async (signal) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      signal.addEventListener("abort", () => controller.error(new Error("aborted upstream")), { once: true });
    } }));
  });
  const reading = response.text();
  await vi.advanceTimersByTimeAsync(0);
  stopped = true;
  await vi.advanceTimersByTimeAsync(1000);
  // Stop is not a server failure: no failed pipe, no 500.
  await expect(reading).resolves.toBe("partial");
  expect(upstreamSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("still interrupts the stream as a failure when the upstream fails while the client waits", async () => {
  const response = await withRunnerGatewayLease(new Request("http://agent.invalid"), async () => {}, async () =>
    new Response(new ReadableStream({ pull(controller) { controller.error(new Error("upstream failed")); } })));
  await expect(response.text()).rejects.toThrow("agent_request_interrupted");
});

it("releases its watchdog when the stream ends normally", async () => {
  vi.useFakeTimers();
  const response = await withRunnerGatewayLease(new Request("http://agent.invalid"), async () => {}, async () => new Response("ok"));
  expect(await response.text()).toBe("ok");
  expect(vi.getTimerCount()).toBe(0);
});
