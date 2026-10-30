import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSubagentRunner, endedSubagentResult } from "../../../../tests/support/subagentPorts";
import type { SubagentTurnInput } from "../../subagents/ports";
import { workspaceRunOutputDirectory } from "../../../domain/workspace";
import type { ProviderRunRequest } from "../../providers/types";
import { backgroundSubagentRunner, hasSubagentBackgroundHost, registerSubagentBackgroundHost } from "./backgroundRunner";
import { WORKSPACE_TURN_GUIDANCE_PREFIX } from "./runner";
import { backgroundSubagentRequest } from "./runSubagents";

const turn = (overrides: Partial<SubagentTurnInput> = {}): SubagentTurnInput => ({
  binding: { effortSource: "parent", modelId: "model", modelSource: "parent", provider: "connection", providerModelId: "model-1",
    reasoningEffort: null },
  brief: "Watch the shop.", chatId: "chat", deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run-bg", mode: "background",
  name: "watcher", parentRunId: "parent-run", parentToolCallId: "call-row", signal: new AbortController().signal, threadId: "thread",
  turnId: `turn-${Math.random()}`, type: null, userId: "user", userMessage: "Watch it.", ...overrides
});

afterEach(() => vi.useRealTimers());

describe("the engine's background runner", () => {
  it("runs a background turn on its parent run's host and answers for it until it ended", async () => {
    const runner = new FakeSubagentRunner();
    const host = registerSubagentBackgroundHost("parent-run", () => runner, 1_000);
    const input = turn();
    const handle = await backgroundSubagentRunner.start(input);
    expect(runner.turns.get(input.turnId)?.input.hostRunId).toBe("run-bg");
    await expect(backgroundSubagentRunner.deliver(handle, { nonce: "n", origin: "main_agent", text: "Also check the outlet." }))
      .resolves.toMatchObject({ kind: "delivered" });
    runner.finish(input.turnId, endedSubagentResult("watcher"));
    await expect(backgroundSubagentRunner.wait(handle)).resolves.toMatchObject({ name: "watcher", state: "done" });
    // A host a turn began on is used: it outlives its run for the grace.
    host.release();
    expect(hasSubagentBackgroundHost("parent-run")).toBe(true);
  });

  it("refuses a turn without its parent's host, and a foreground turn", async () => {
    await expect(backgroundSubagentRunner.start(turn({ parentRunId: "elsewhere" }))).rejects.toThrow("subagent_parent_unavailable");
    registerSubagentBackgroundHost("parent-fg", () => new FakeSubagentRunner());
    await expect(backgroundSubagentRunner.start(turn({ mode: "foreground", parentRunId: "parent-fg" })))
      .rejects.toThrow("subagent_turn_mode_invalid");
    await expect(backgroundSubagentRunner.stop({ turnId: "unknown" }, "user_stop")).resolves.toBeNull();
    await expect(backgroundSubagentRunner.deliver({ turnId: "unknown" }, { nonce: "n", origin: "main_agent", text: "x" }))
      .resolves.toEqual({ kind: "not_found" });
  });

  it("drops a host no background start was asked for as soon as its run ended", () => {
    registerSubagentBackgroundHost("parent-unused", () => new FakeSubagentRunner(), 5_000).release();
    expect(hasSubagentBackgroundHost("parent-unused")).toBe(false);
  });

  it("keeps a used parent's host for its grace after the parent ended, then drops it", async () => {
    vi.useFakeTimers();
    const host = registerSubagentBackgroundHost("parent-grace", () => new FakeSubagentRunner(), 5_000);
    // The call asked for a background start before its admission, which may outlast the run.
    host.use();
    host.release();
    expect(hasSubagentBackgroundHost("parent-grace")).toBe(true);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(hasSubagentBackgroundHost("parent-grace")).toBe(false);
  });

  it("gives a background turn's run its own output folder, in its Workspace and its turn guidance", () => {
    const parentFolder = workspaceRunOutputDirectory("parent-run");
    const request = { prompt: { developer: null, system: "Base.", turnGuidance: [`${WORKSPACE_TURN_GUIDANCE_PREFIX}${parentFolder}.`, "Other."] },
      workspace: { enabled: true, outputDirectory: parentFolder } } as unknown as ProviderRunRequest;
    const own = backgroundSubagentRequest(request, "run-bg");
    expect(own.workspace?.outputDirectory).toBe(workspaceRunOutputDirectory("run-bg"));
    expect(own.prompt.turnGuidance).toEqual([`${WORKSPACE_TURN_GUIDANCE_PREFIX}${workspaceRunOutputDirectory("run-bg")}.`, "Other."]);
    const plain = { prompt: { developer: null, system: null } } as unknown as ProviderRunRequest;
    expect(backgroundSubagentRequest(plain, "run-bg")).toBe(plain);
  });
});
