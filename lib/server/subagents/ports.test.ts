// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FakeBrowserAgentIdentity,
  FakeSubagentBackgroundControl,
  FakeSubagentCallbackSink,
  FakeSubagentRunner,
  FakeSubagentTypeResolver,
  FakeWorkspaceAttachments,
  endedSubagentResult
} from "@/tests/support/subagentPorts";
import { decodeSubagentCallResult } from "../../contracts/subagents";
import type { SubagentBackgroundStartInput, SubagentTurnInput } from "./ports";

function turnInput(turnId: string, signal = new AbortController().signal): SubagentTurnInput {
  return {
    binding: { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "fake", providerModelId: null, reasoningEffort: null },
    brief: "Synthetic brief", chatId: "chat-1", deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run-1", mode: "foreground",
    name: "shop-amazon", parentRunId: "run-1", parentToolCallId: "call-1", signal, threadId: "thread-1", turnId, type: null,
    userId: "user-1", userMessage: "Synthetic user message"
  };
}

describe("sub-agent port fakes", () => {
  it("runs a turn until it is finished, delivering messages once and waking waiters", async () => {
    const runner = new FakeSubagentRunner();
    const handle = await runner.start(turnInput("turn-1"));
    const waited = runner.wait(handle);
    const message = { nonce: "call-2", origin: "main_agent" as const, text: "Also check warranties." };
    await expect(runner.deliver(handle, message)).resolves.toEqual({ kind: "delivered", state: "running" });
    await runner.deliver(handle, message);
    expect(runner.turns.get("turn-1")?.messages).toEqual([message]);
    runner.finish("turn-1", endedSubagentResult("shop-amazon", { report: "Three found." }));
    const result = await waited;
    expect(decodeSubagentCallResult(result)).toEqual(result);
    await expect(runner.deliver(handle, { ...message, nonce: "call-3" })).resolves.toEqual({ kind: "ended", result });
    await expect(runner.deliver({ turnId: "missing" }, message)).resolves.toEqual({ kind: "not_found" });
  });

  it("stops a turn idempotently, and the parent's abort stops its foreground turn", async () => {
    const runner = new FakeSubagentRunner();
    const handle = await runner.continue(turnInput("turn-1"));
    const stopped = await runner.stop(handle, "stop_subagent");
    expect(stopped).toMatchObject({ reason: "stop_subagent", state: "stopped" });
    expect(decodeSubagentCallResult(stopped)).toEqual(stopped);
    await expect(runner.stop(handle, "user_stop")).resolves.toEqual(stopped);
    const parent = new AbortController();
    const child = await runner.start(turnInput("turn-2", parent.signal));
    parent.abort();
    await expect(runner.wait(child)).resolves.toMatchObject({ reason: "parent_stopped", state: "stopped" });
    const third = await runner.start(turnInput("turn-3"));
    runner.interruptAll();
    await expect(runner.wait(third)).resolves.toMatchObject({ reason: "restart", state: "interrupted" });
  });

  it("admits background turns, delivers to their mailbox and stops them by name", async () => {
    const control = new FakeSubagentBackgroundControl();
    const caller = { chatId: "chat-1", parentRunId: "run-1", parentToolCallId: "call-1", userId: "user-1" };
    const start = (threadId: string, name: string): SubagentBackgroundStartInput => ({ ...caller, binding: turnInput("x").binding,
      brief: "Synthetic brief", kind: "start", name, threadId, type: null, userMessage: "Synthetic user message" });
    await expect(control.availability()).resolves.toEqual({ available: true });
    const started = await control.start(start("thread-1", "shop-amazon"));
    expect(started).toEqual({ kind: "started", name: "shop-amazon", state: "running", turnId: "background-turn-1" });
    // A thread has one active run at a time.
    await expect(control.start({ ...start("thread-1", "shop-amazon"), kind: "continue" }))
      .resolves.toEqual({ code: "subagent_busy", kind: "refused" });
    const message = { nonce: "call-2", origin: "main_agent" as const, text: "Also check warranties." };
    await expect(control.deliver({ ...caller, message, name: "shop-amazon", threadId: "thread-1" }))
      .resolves.toEqual({ kind: "delivered", state: "running" });
    await control.deliver({ ...caller, message, name: "shop-amazon", threadId: "thread-1" });
    expect(control.turns[0]?.messages).toEqual([message]);
    const stopped = await control.stop({ ...caller, name: "shop-amazon" });
    expect(stopped).toMatchObject({ kind: "stopped", result: { reason: "stop_subagent", state: "stopped" } });
    await expect(control.stop({ ...caller, name: "shop-amazon" })).resolves.toEqual(stopped);
    await expect(control.deliver({ ...caller, message, name: "shop-amazon", threadId: "thread-1" }))
      .resolves.toMatchObject({ kind: "ended" });
    await expect(control.stop({ ...caller, name: "missing" })).resolves.toEqual({ kind: "not_found" });
    // The stopped thread continues in a new background turn.
    await expect(control.start({ ...start("thread-1", "shop-amazon"), kind: "continue" })).resolves.toMatchObject({ kind: "started" });
  });

  it("refuses background turns visibly: the running cap, usage limits and runs without background mode", async () => {
    const caller = { chatId: "chat-1", parentRunId: "run-1", parentToolCallId: "call-1", userId: "user-1" };
    const start = (index: number): SubagentBackgroundStartInput => ({ ...caller, binding: turnInput("x").binding, brief: "b", kind: "start",
      name: `agent-${index}`, threadId: `thread-${index}`, type: null, userMessage: "m" });
    const control = new FakeSubagentBackgroundControl();
    for (let index = 0; index < 20; index += 1) await expect(control.start(start(index))).resolves.toMatchObject({ kind: "started" });
    await expect(control.start(start(20))).resolves.toEqual({ code: "subagent_limit_reached", kind: "refused" });
    await expect(new FakeSubagentBackgroundControl({ refuse: "subagent_usage_limited" }).start(start(0)))
      .resolves.toEqual({ code: "subagent_usage_limited", kind: "refused" });
    const unavailable = new FakeSubagentBackgroundControl({ available: false });
    await expect(unavailable.availability()).resolves.toEqual({ available: false, code: "subagent_background_unavailable" });
    await expect(unavailable.start(start(0))).resolves.toEqual({ code: "subagent_background_unavailable", kind: "refused" });
  });

  it("records callbacks with their disposition", async () => {
    const sink = new FakeSubagentCallbackSink((callback) => callback.turnId === "turn-2" ? "inactive_branch" : "wake_up");
    const callback = { chatId: "chat-1", name: "a", parentRunId: "run-1", result: endedSubagentResult("a"), threadId: "t", turnId: "turn-1",
      userId: "user-1" };
    await expect(sink.deliver(callback)).resolves.toBe("wake_up");
    await expect(sink.deliver({ ...callback, turnId: "turn-2" })).resolves.toBe("inactive_branch");
    expect(sink.callbacks).toHaveLength(2);
  });

  it("shares one Workspace between runs and refuses Reset while a sub-agent run is attached", async () => {
    const attachments = new FakeWorkspaceAttachments({ unknownExecutionStopsVm: true });
    const scope = { chatId: "chat-1", userId: "user-1" };
    await attachments.attach({ ...scope, agent: { kind: "main" }, modelRunId: "run-main" });
    await expect(attachments.attach({ ...scope, agent: { kind: "subagent", name: "a", threadId: "t" }, modelRunId: "run-sub" }))
      .resolves.toMatchObject({ attachedRuns: 2, kind: "attached" });
    await expect(attachments.exclusive({ ...scope, operation: "reset" }, async () => "reset"))
      .resolves.toEqual({ code: "workspace_subagents_running", kind: "refused" });
    await expect(attachments.exclusive({ ...scope, operation: "export_capture" }, async ({ sessionId }) => sessionId))
      .resolves.toEqual({ kind: "done", value: "session-chat-1" });
    await expect(attachments.detach({ ...scope, execution: "unknown", modelRunId: "run-sub" }))
      .resolves.toEqual({ interruptedRunIds: ["run-main"], kind: "detached", remainingRuns: 0 });
    await expect(attachments.exclusive({ ...scope, operation: "reset" }, async () => "reset")).resolves.toEqual({ kind: "done", value: "reset" });
  });

  it("builds the real exec identity and records slot releases", async () => {
    const identity = new FakeBrowserAgentIdentity();
    expect(identity.environment({ kind: "subagent", name: "a", threadId: "thread-1" })).toEqual({ AIQSA_AGENT_ID: "thread-1", AIQSA_AGENT_NAME: "a" });
    await identity.release({ agent: { kind: "main" }, chatId: "chat-1", modelRunId: "run-1", userId: "user-1" });
    expect(identity.releases).toHaveLength(1);
  });

  it("resolves only the user's own custom sub-agents", async () => {
    const browser = { definitionId: "d1", description: "Long browsing", instructions: "Browse.", name: "browser", providerModelId: null,
      reasoningEffort: null, revisionId: "r1", toolGroups: ["workspace" as const] };
    const resolver = new FakeSubagentTypeResolver({ "user-1": [browser] });
    await expect(resolver.catalog({ userId: "user-1" })).resolves.toEqual([{ description: "Long browsing", name: "browser" }]);
    await expect(resolver.resolve({ name: "browser", userId: "user-1" })).resolves.toEqual({ kind: "found", type: browser });
    await expect(resolver.resolve({ name: "browser", userId: "user-2" })).resolves.toEqual({ kind: "unavailable" });
    // A thread continues by its definition, whatever the definition is called now.
    const renamed = new FakeSubagentTypeResolver({ "user-1": [{ ...browser, name: "shopper" }] });
    await expect(renamed.resolve({ definitionId: "d1", userId: "user-1" })).resolves.toEqual({ kind: "found", type: { ...browser, name: "shopper" } });
    await expect(renamed.resolve({ name: "browser", userId: "user-1" })).resolves.toEqual({ kind: "unavailable" });
    await expect(renamed.resolve({ definitionId: "d1", userId: "user-2" })).resolves.toEqual({ kind: "unavailable" });
  });
});
