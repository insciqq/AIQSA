import { describe, expect, it } from "vitest";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import { liveStatusLabelV2, type LiveStatusInputV2 } from "./liveStatusLabel";
import { SUBAGENT_WAIT_LABEL_V2 } from "./runPresentation";

const idle = "Musing…";
const logs = { origin: "mcp", round: 1, serverName: "Logs", status: "running", toolName: "tail" } as const;
const repo = { origin: "mcp", round: 2, serverName: "Repository Tools", status: "running", toolName: "search" } as const;
const subagent = { origin: "tool", round: 1, serverName: "shop", status: "running", toolName: "call_subagent" } as const;
const inner = { origin: "web_search", round: 1, status: "running", subagentThreadId: "t", subagentTurnId: "u", toolName: "search_web" } as const;
const plan = { origin: "session", round: 2, status: "running", toolName: "update_plan" } as const;
const finished: ThreadWorkspaceActivity = { entries: [{ command: { exitCode: 0, preview: "npm test" }, id: "test", kind: "command", phase: "succeeded" }] };
const running: ThreadWorkspaceActivity = { entries: [{ command: { preview: "pytest" }, id: "py", kind: "command", phase: "running" }] };

const cases: readonly (readonly [string, Omit<LiveStatusInputV2, "idle">, string])[] = [
  ["names nothing without work", {}, idle],
  ["keeps a final synthesis over every running step",
    { phase: { kind: "synthesis", label: "Finishing the answer…" }, toolCalls: [logs], workspaceActivity: running }, "Finishing the answer…"],
  ["keeps a compaction over every running step",
    { phase: { kind: "compaction", label: "Compacting context…" }, toolCalls: [logs], workspaceActivity: running }, "Compacting context…"],
  // 9ce3450d0: a running Workspace step still wins over a later phase.
  ["keeps a running Workspace step over a later phase",
    { phase: { kind: "results", label: idle, reasoningHeading: "Checking the output" }, workspaceActivity: running }, "Running pytest…"],
  // 9ce3450d0: a phase that began after a finished Workspace step replaces the generic Workspace label, with its heading.
  ["lets a later phase pass the generic Workspace label",
    { phase: { kind: "results", label: idle, reasoningHeading: "Checking the output" }, workspaceActivity: finished }, "Checking the output"],
  ["keeps the generic Workspace label without a later phase",
    { phase: { kind: "provider", label: idle }, workspaceActivity: finished }, "Working in Workspace…"],
  // d0a1dcdd4: a live call reads as running until it settles, so a later phase supersedes its label.
  ["lets a later phase supersede a call still shown as running",
    { phase: { kind: "files", label: "Reading files…" }, toolCalls: [logs] }, "Reading files…"],
  // b937cf737: a silent or failing provider is named over a finished Workspace step and a running call.
  ["names a slow provider over the generic Workspace label and a running call",
    { phase: { kind: "provider_slow", label: "The model provider is taking longer than usual…" }, toolCalls: [logs], workspaceActivity: finished },
    "The model provider is taking longer than usual…"],
  ["names a retrying provider over a running call",
    { phase: { kind: "provider_retrying", label: "The model provider isn’t responding, trying again…" }, toolCalls: [logs] },
    "The model provider isn’t responding, trying again…"],
  // d0a1dcdd4: a settled call stops naming the line.
  ["names no settled call", { toolCalls: [{ ...logs, status: "complete" }, { ...repo, status: "error" }] }, idle],
  ["names the newest running call", { toolCalls: [logs, { ...repo, status: "complete" }, repo] }, "Using Repository Tools: search…"],
  ["names a running call over the phase's own label", { phase: { kind: "provider", label: idle, reasoningHeading: "Weighing it" }, toolCalls: [logs] },
    "Using Logs: tail…"],
  // 9ce3450d0: the model's own heading replaces the waiting label whatever the Reasoning blocks setting.
  ["shows the reasoning heading in place of the waiting label", { phase: { kind: "provider", label: idle, reasoningHeading: "Weighing it" } },
    "Weighing it"],
  ["never names a plan update", { toolCalls: [logs, plan] }, "Using Logs: tail…"],
  ["shows the idle line while only a plan update runs", { toolCalls: [plan] }, idle],
  // fd915b716: a sub-agent has its own row, so its call and its steps never name the line.
  ["waits neutrally while only sub-agents work", { toolCalls: [subagent, inner] }, SUBAGENT_WAIT_LABEL_V2],
  ["names the agent's own work beside newer sub-agent steps", { toolCalls: [logs, subagent, inner] }, "Using Logs: tail…"],
  ["waits neutrally for a sub-agent the phase names", { phase: { kind: "tool", label: SUBAGENT_WAIT_LABEL_V2 }, toolCalls: [subagent] },
    SUBAGENT_WAIT_LABEL_V2]
];

describe("live status label", () => {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(liveStatusLabelV2({ idle, ...input })).toBe(expected);
  });

  it("gives a sub-agent's turn, which has no server phase, the line of an answer waiting on its model", () => {
    for (const [, input] of cases) {
      if (input.phase && input.phase.kind !== "provider") continue;
      const answer = liveStatusLabelV2({ idle, ...input, phase: { kind: "provider", label: idle } });
      expect(liveStatusLabelV2({ idle, toolCalls: input.toolCalls, workspaceActivity: input.workspaceActivity })).toBe(answer);
    }
  });
});
