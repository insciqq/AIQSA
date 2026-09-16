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

it("releases its watchdog when the stream ends normally", async () => {
  vi.useFakeTimers();
  const response = await withAgentLease(new Request("http://agent.invalid"), async () => {}, async () => new Response("ok"));
  expect(await response.text()).toBe("ok");
  expect(vi.getTimerCount()).toBe(0);
});
