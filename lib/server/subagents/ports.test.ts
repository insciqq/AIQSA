// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FakeBrowserAgentIdentity,
  FakeSubagentCallbackSink,
  FakeSubagentRunner,
  FakeSubagentTypeResolver,
  FakeWorkspaceAttachments,
  endedSubagentResult
} from "@/tests/support/subagentPorts";
import { decodeSubagentCallResult } from "../../contracts/subagents";
import type { SubagentTurnInput } from "./ports";

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
  });
});
