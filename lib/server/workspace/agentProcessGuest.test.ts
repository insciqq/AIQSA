// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWorkspaceAgentStopOutcome,
  WORKSPACE_AGENT_STOP_GUEST_SCRIPT,
  workspaceAgentStopRequest
} from "./agentProcessGuest";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

/** Runs one function of the helper (loaded as a module, not as its main) and returns its JSON answer. */
function helper(call: string, args: readonly string[]): unknown {
  const harness = `import json, sys\nnamespace = {'__name__': 'harness'}\nexec(sys.stdin.read(), namespace)\n` +
    `args = sys.argv[1:]\nprint(json.dumps(${call}))`;
  const result = spawnSync("python3", ["-I", "-c", harness, ...args], { encoding: "utf8", input: WORKSPACE_AGENT_STOP_GUEST_SCRIPT });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

function sleeper(agentId: string): ChildProcess {
  const child = spawn("sleep", ["30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AIQSA_AGENT_ID: agentId }, stdio: "ignore" });
  children.push(child);
  return child;
}

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "aiqsa-agent-stop-"));
  directories.push(created);
  return created;
}

describe("the agent stop helper", () => {
  it("finds exactly the processes started for one agent", async () => {
    const mine = sleeper("thread-a");
    const other = sleeper("thread-b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = helper("namespace['agent_pids']('/proc', args[0], set())", ["thread-a"]) as number[];
    expect(found).toContain(mine.pid);
    expect(found).not.toContain(other.pid);
  });

  it("proves an agent with nothing left closed without needing a cgroup", () => {
    expect(helper("namespace['stop']('/proc', args[0], 'nobody-runs-this')", [directory()])).toEqual(["closed", "none"]);
  });

  it("answers unknown, never closed, where it cannot prove a stop", async () => {
    sleeper("thread-c");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // No cgroup v2 hierarchy at all.
    expect(helper("namespace['stop']('/proc', args[0], 'thread-c')", [directory()])).toEqual(["unknown", "cgroup_unavailable"]);
    // A hierarchy without `cgroup.kill` (a kernel before 5.14): the group it made is removed again.
    const root = directory();
    writeFileSync(join(root, "cgroup.controllers"), "");
    expect(helper("namespace['stop']('/proc', args[0], 'thread-c')", [root])).toEqual(["unknown", "cgroup_kill_unavailable"]);
    expect(readdirSync(root)).toEqual(["cgroup.controllers"]);
    // An id the protocol cannot carry.
    expect(helper("namespace['stop']('/proc', args[0], '../main')", [root])).toEqual(["unknown", "invalid"]);
    expect(existsSync(join(root, "cgroup.controllers"))).toBe(true);
  });

  it("reads only the helper's own outcome line, and builds only protocol ids", () => {
    expect(parseWorkspaceAgentStopOutcome('{"outcome":"closed","code":"killed"}\n')).toEqual({ outcome: "closed" });
    expect(parseWorkspaceAgentStopOutcome('{"outcome":"unknown","code":"timeout"}')).toEqual({ outcome: "unknown" });
    expect(parseWorkspaceAgentStopOutcome("closed")).toEqual({ outcome: "unknown" });
    expect(parseWorkspaceAgentStopOutcome('{"outcome":"closed"}\n{"outcome":"closed"}')).toEqual({ outcome: "unknown" });
    expect(workspaceAgentStopRequest("main").toString()).toBe('{"agentId":"main"}\n');
    expect(() => workspaceAgentStopRequest("a b")).toThrow("workspace_agent_identity_invalid");
  });
});
