import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunTool } from "../tools/types";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderHistoryItem } from "./history";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

const callSubagent: RunTool = { capability: "session", description: "Start a sub-agent", inputSchema: { type: "object" },
  name: "call_subagent" };
const fsWrite: RunTool = { capability: "workspace", description: "Write a file", inputSchema: { type: "object" },
  name: "mcp_workspace_sandbox_fs_write_0123456789" };
afterEach(() => vi.unstubAllEnvs());

function request(history: ProviderHistoryItem[], tools: RunTool[]): ProviderRunRequest {
  return { content: { blocks: [] }, history, searchPlan: { mode: "all_selected", options: [] }, tools,
    workspace: { enabled: true } } as unknown as ProviderRunRequest;
}

async function run(input: ProviderRunRequest, signal?: AbortSignal): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input, signal ? { signal } : {});
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

const ask = "Compare offers [AIQSA_SUBAGENT_E2E:bg:alpha,beta:write]";

describe("fake provider sub-agent scenario", () => {
  it("starts one background sub-agent per name in one round, then answers with their states, once per turn", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    const user: ProviderHistoryItem = { currentInput: true, text: ask, type: "user" };
    const first = await run(request([user], [callSubagent]));
    expect(first.toolCalls).toEqual([
      { arguments: { background: true, message: "[AIQSA_SUBAGENT_TASK:alpha:write] Do the task and report.", name: "alpha" },
        id: "fake-subagent-call-0-0", name: "call_subagent" },
      { arguments: { background: true, message: "[AIQSA_SUBAGENT_TASK:beta:write] Do the task and report.", name: "beta" },
        id: "fake-subagent-call-0-1", name: "call_subagent" }
    ]);
    const results: ProviderHistoryItem[] = first.toolCalls!.map((call, index) => ({ callId: call.id, name: call.name,
      output: JSON.stringify(index === 0 ? { kind: "started", name: "alpha", state: "running" } : { error: "subagent_limit_reached" }),
      type: "tool_result" as const }));
    const calls: ProviderHistoryItem[] = first.toolCalls!.map((call) => ({ arguments: JSON.stringify(call.arguments), callId: call.id,
      name: call.name, type: "tool_call" as const }));
    const answer = await run(request([user, ...calls, ...results], [callSubagent]));
    expect(answer.finalText).toBe("Sub-agents started: alpha started; beta subagent_limit_reached.");
    // A callback delivered into the answer is user input after the calls; the main agent does not call again.
    const callback: ProviderHistoryItem = { text: "[Sub-agent callback, written by the server, not by the user] ...", type: "user" };
    expect((await run(request([user, ...calls, ...results, callback], [callSubagent]))).toolCalls ?? []).toEqual([]);
  });

  it("runs a sub-agent's brief: its Workspace write, its wait cut by Stop, then its report", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    const brief: ProviderHistoryItem = { text: `<main_agent_brief>\n[AIQSA_SUBAGENT_TASK:alpha:write,wait50] Do it.\n</main_agent_brief>\n${ask}`,
      type: "user" };
    const write = await run(request([brief], [fsWrite]));
    expect(write.toolCalls?.[0]).toMatchObject({ arguments: { path: "/workspace/project/alpha/report.txt" }, name: fsWrite.name });
    const done: ProviderHistoryItem[] = [{ arguments: "{}", callId: write.toolCalls![0]!.id, name: fsWrite.name, type: "tool_call" },
      { callId: write.toolCalls![0]!.id, name: fsWrite.name, output: "{}", type: "tool_result" }];
    expect((await run(request([brief, ...done], [fsWrite]))).finalText).toBe("Outcome: done\nReport from alpha: steps complete.");
    const stop = new AbortController();
    const waiting = run(request([{ ...brief, text: brief.text.replace("wait50", "wait60000") }, ...done], [fsWrite]), stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow("provider_run_aborted");
  });

  it("answers a wake-up turn with the sub-agents that ended", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    const text = "[Sub-agent callbacks, written by the server, not by the user] Background sub-agents you started ended.\n" +
      "--- \"alpha\" (done)\n{}\n--- \"beta\" (stopped, user_stop)\n{}";
    expect((await run(request([{ currentInput: true, text, type: "user" }], [callSubagent]))).finalText)
      .toBe("Wake-up answer: alpha done; beta stopped, user_stop.");
  });

  it("never activates outside test mode or in production", async () => {
    for (const env of [{ mode: "0", node: "test" }, { mode: "1", node: "production" }]) {
      vi.stubEnv("AIQSA_TEST_MODE", env.mode);
      vi.stubEnv("NODE_ENV", env.node);
      expect((await run(request([{ currentInput: true, text: ask, type: "user" }], [callSubagent]))).toolCalls ?? []).toEqual([]);
    }
  });
});
