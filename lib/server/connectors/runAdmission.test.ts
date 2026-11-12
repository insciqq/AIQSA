import { describe, expect, it, vi } from "vitest";
import { encodeSseEvent, type ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import { connectorSendRefusal, createConnectorRunWait, followConnectorSend, type ConnectorSendFollowInput } from "./runAdmission";
import type { ConnectorRunStreamEvent } from "./runEvents";

function streamed(events: readonly ModelRunSseEvent[]): Response {
  return new Response(events.map(encodeSseEvent).join(""), { headers: { "content-type": "text/event-stream" }, status: 200 });
}

function follow(overrides: Partial<ConnectorSendFollowInput> = {}) {
  const recordRun = vi.fn(async () => true);
  const waitForRun = vi.fn<ConnectorSendFollowInput["waitForRun"]>(async () => "complete");
  return { input: { followMs: 60_000, now: () => 0, recordRun, userId: "user-1", waitForRun, ...overrides }, recordRun, waitForRun };
}

async function all(events: AsyncIterable<ConnectorRunStreamEvent>): Promise<ConnectorRunStreamEvent[]> {
  const seen: ConnectorRunStreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("following a connector's send", () => {
  it("records the run once it is known and hands over its events up to the terminal one", async () => {
    const { input, recordRun, waitForRun } = follow();
    const followed = await followConnectorSend(streamed([
      { data: { modelId: "m", provider: "fake", runId: "run-1", status: "streaming" }, type: "run_start" },
      { data: { assistantMessageId: "answer-1", userMessageId: "question-1" }, type: "message_start" },
      { data: { delta: "Hello" }, type: "token" },
      { data: { round: 1 }, type: "message_reset" },
      { data: { delta: "Hi" }, type: "token" },
      { data: { runId: "run-1", status: "complete" }, type: "done" }
    ]), input);
    expect(followed).toMatchObject({ assistantMessageId: "answer-1", deferred: false, kind: "admitted", runId: "run-1", runLinked: true,
      userMessageId: "question-1" });
    expect(recordRun).toHaveBeenCalledExactlyOnceWith("run-1");
    if (followed.kind !== "admitted") throw new Error("admitted");
    expect(await all(followed.events)).toEqual([
      { delta: "Hello", type: "answerDelta" }, { type: "answerReset" }, { delta: "Hi", type: "answerDelta" }, { status: "complete", type: "done" }
    ]);
    expect(waitForRun).not.toHaveBeenCalled();
  });

  it("follows the run's state when its stream ends before the terminal frame", async () => {
    const { input, waitForRun } = follow();
    const followed = await followConnectorSend(streamed([
      { data: { modelId: "m", provider: "fake", runId: "run-2", status: "streaming" }, type: "run_start" },
      { data: { assistantMessageId: "answer-2", userMessageId: "question-2" }, type: "message_start" }
    ]), input);
    if (followed.kind !== "admitted") throw new Error("admitted");
    expect(await all(followed.events)).toEqual([{ status: "complete", type: "done" }]);
    expect(waitForRun).toHaveBeenCalledWith({ deadline: 60_000, runId: "run-2", userId: "user-1" });
  });

  it("follows a deferred admission through its state, recording it first", async () => {
    const { input, recordRun } = follow({ waitForRun: async () => "gone" });
    const followed = await followConnectorSend(Response.json({
      assistantMessageId: "answer-3", run: { id: "run-3", status: "queued" }, userMessageId: "question-3", version: 1
    }, { status: 202 }), input);
    expect(followed).toMatchObject({ deferred: true, kind: "admitted", runId: "run-3", runLinked: true });
    expect(recordRun).toHaveBeenCalledExactlyOnceWith("run-3");
    if (followed.kind !== "admitted") throw new Error("admitted");
    expect(await all(followed.events)).toEqual([
      { status: "queued", type: "preparing" }, { code: "model_run_not_found", message: null, type: "failed" }
    ]);
  });

  it("answers a refusal with its code and facts, and records nothing", async () => {
    const { input, recordRun } = follow();
    const refused = await followConnectorSend(Response.json({ error: "usage_budget_exhausted", usageLimit: { limit: 5, window: "month" } },
      { headers: { "retry-after": "120" }, status: 429 }), input);
    expect(refused).toEqual({ kind: "refused", refusal: { code: "usage_budget_exhausted", retryAfterSeconds: 120, status: 429,
      usageLimit: { limit: 5, window: "month" } } });
    expect(connectorSendRefusal(new Response(null, { status: 401 }), { error: "anything" })).toEqual({ code: "unauthorized", status: 401 });
    expect(connectorSendRefusal(new Response(null, { status: 409 }), { error: "active_run_in_progress", run: { id: "run-9" } }))
      .toEqual({ activeRunId: "run-9", code: "active_run_in_progress", status: 409 });
    const failed = await followConnectorSend(streamed([{ data: { code: "model_unavailable", message: "x" }, type: "error" }]), input);
    expect(failed).toEqual({ kind: "refused", refusal: { code: "model_unavailable", status: 500 } });
    expect(recordRun).not.toHaveBeenCalled();
  });
});

describe("waiting for a connector's run", () => {
  it("reads its state with a backoff until it settles, is gone or the deadline passes", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const states = [{ status: "streaming" }, { status: "streaming" }, { status: "complete" }];
    const runState = vi.fn(async () => states.shift() ?? null);
    const wait = createConnectorRunWait({ runState }, { now: () => now, sleep });
    await expect(wait({ deadline: 60_000, runId: "run-1", userId: "user-1" })).resolves.toBe("complete");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    await expect(wait({ deadline: 60_000, runId: "run-1", userId: "user-1" })).resolves.toBe("gone");
    const stuck = createConnectorRunWait({ runState: async () => ({ status: "streaming" }) }, { now: () => now, sleep });
    await expect(stuck({ deadline: now + 2_500, runId: "run-1", userId: "user-1" })).resolves.toBeNull();
  });
});
