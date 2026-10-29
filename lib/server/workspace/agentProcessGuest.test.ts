// @vitest-environment node
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWorkspaceAgentStopOutcome,
  WORKSPACE_AGENT_STOP_GUEST_SCRIPT,
  workspaceAgentLaunchArguments,
  workspaceAgentStopRequest
} from "./agentProcessGuest";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "aiqsa-agent-stop-"));
  directories.push(created);
  return created;
}

/**
 * A fake cgroup v2 root and run directory. `kernel` emulates what `cgroup.kill` does: once it holds `1`, every pid
 * of the group's `cgroup.procs` gets SIGKILL and leaves the group, whatever its environment.
 */
function fakeGuest(): Readonly<{ cgroot: string; group: (agent: string, pids: readonly number[]) => string; run: string }> {
  const cgroot = directory();
  const run = directory();
  writeFileSync(join(cgroot, "cgroup.controllers"), "cpu memory\n");
  return {
    cgroot,
    group(agent, pids) {
      const path = join(cgroot, `aiqsa-agent-${agent}`);
      mkdirSync(path);
      writeFileSync(join(path, "cgroup.procs"), pids.map((pid) => `${pid}\n`).join(""));
      writeFileSync(join(path, "cgroup.kill"), "");
      return path;
    },
    run
  };
}

const KERNEL = String.raw`
import os, signal, time
def kernel_pause(seconds):
    for name in os.listdir(cgroot):
        group = os.path.join(cgroot, name)
        if not name.startswith('aiqsa-agent-') or not os.path.isdir(group):
            continue
        kill = os.path.join(group, 'cgroup.kill')
        if os.path.exists(kill) and open(kill).read().strip() == '1' and effective:
            for pid in open(os.path.join(group, 'cgroup.procs')).read().split():
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            open(os.path.join(group, 'cgroup.procs'), 'w').close()
    time.sleep(seconds)
ticks = [0.0]
def jumping_clock():
    ticks[0] += 1.0
    return ticks[0]
`;

/** Runs the helper's `stop` (the script loaded as a module, not as its main) against the fake guest. */
function stop(guest: ReturnType<typeof fakeGuest>, agent: string, options: Readonly<{ effectiveKill?: boolean }> = {}): unknown {
  const harness = `import json, sys\nnamespace = {'__name__': 'harness'}\nexec(sys.stdin.read(), namespace)\n` +
    `cgroot, run_dir, agent = sys.argv[1:4]\neffective = ${options.effectiveKill === false ? "False" : "True"}\n${KERNEL}\n` +
    `print(json.dumps(namespace['stop'](cgroot, run_dir, agent, clock=jumping_clock if not effective else namespace['time'].monotonic, pause=kernel_pause)))`;
  const result: SpawnSyncReturns<string> = spawnSync("python3", ["-I", "-c", harness, guest.cgroot, guest.run, agent],
    { encoding: "utf8", input: WORKSPACE_AGENT_STOP_GUEST_SCRIPT, timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

/**
 * A child's whole environment, deliberately minimal (empty for a child that replaced its environment), typed as
 * the project's augmented `ProcessEnv`, which these commands never read.
 */
function commandEnvironment(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...values } as unknown as NodeJS.ProcessEnv;
}

/** A process started with a replaced environment (`env -i`): nothing in it names an agent. */
function strippedChild(): ChildProcess {
  const options: SpawnOptions = { env: commandEnvironment({}), stdio: "ignore" };
  const child = spawn("/bin/sleep", ["30"], options);
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once("exit", (_code: number | null, signal: NodeJS.Signals | null) => resolve(signal));
  });
}

describe("the agent launcher", () => {
  it("starts a shell command's own lines inside its agent's cgroup, in the same shell", () => {
    const launched = workspaceAgentLaunchArguments("sandbox_shell", { command: "ls | wc -l", env: { A: "1" } }, "thread-1");
    expect(launched.env).toEqual({ A: "1" });
    const command = launched.command as string;
    expect(command.endsWith("\nls | wc -l")).toBe(true);
    expect(command).toContain("/sys/fs/cgroup/aiqsa-agent-thread-1/cgroup.procs");
    expect(command).toContain("echo $$ >");
    expect(command).toContain("/run/aiqsa-agent-untracked-thread-1");
    // The same shell runs the command after the placement (here off a guest, where the placement fails quietly).
    const shell = workspaceAgentLaunchArguments("sandbox_shell", { command: "echo \"$0\" kept; exit 4" }, "thread-1");
    const result: SpawnSyncReturns<string> = spawnSync("/bin/sh", ["-c", shell.command as string, "own-shell"],
      { encoding: "utf8", env: commandEnvironment({ PATH: "/usr/bin:/bin" }) });
    expect(result.stdout).toBe("own-shell kept\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(4);
  });

  it("runs a direct exec as itself behind the launcher, keeping its argv, output and exit code", () => {
    const launched = workspaceAgentLaunchArguments("sandbox_exec", { args: ["-c", "echo shown; exit 3"], command: "/bin/sh" }, "main");
    expect(launched.command).toBe("/bin/sh");
    const argv = launched.args as string[];
    expect(argv.slice(2)).toEqual(["aiqsa-agent", "/bin/sh", "-c", "echo shown; exit 3"]);
    // Off a guest the placement fails quietly and the command still runs unchanged.
    const result: SpawnSyncReturns<string> = spawnSync("/bin/sh", argv, { encoding: "utf8", env: commandEnvironment({ PATH: "/usr/bin:/bin" }) });
    expect(result.stdout).toBe("shown\n");
    expect(result.status).toBe(3);
    expect(workspaceAgentLaunchArguments("sandbox_exec_start", { command: "python3" }, "main").args)
      .toEqual(expect.arrayContaining(["aiqsa-agent", "python3"]));
  });

  it("leaves other tools and malformed calls as given, and refuses an id the protocol cannot carry", () => {
    expect(workspaceAgentLaunchArguments("sandbox_fs_read", { path: "/x" }, "main")).toEqual({ path: "/x" });
    expect(workspaceAgentLaunchArguments("sandbox_exec", { args: [1], command: "ls" }, "main")).toEqual({ args: [1], command: "ls" });
    expect(() => workspaceAgentLaunchArguments("sandbox_shell", { command: "ls" }, "a b; rm -rf /")).toThrow("workspace_agent_identity_invalid");
  });
});

describe("the agent stop helper", () => {
  it("kills an agent's child that replaced its environment, and only then proves the stop", async () => {
    const guest = fakeGuest();
    const child = strippedChild();
    const other = strippedChild();
    guest.group("thread-a", [child.pid!]);
    guest.group("thread-b", [other.pid!]);
    expect(stop(guest, "thread-a")).toEqual(["closed", "killed"]);
    expect(await exited(child)).toBe("SIGKILL");
    // Another agent's process stays.
    expect(other.exitCode === null && other.signalCode === null).toBe(true);
    expect(readdirSync(guest.cgroot)).toContain("aiqsa-agent-thread-b");
  });

  it("answers unknown, never closed, while the group does not empty", () => {
    const guest = fakeGuest();
    const child = strippedChild();
    guest.group("thread-a", [child.pid!]);
    expect(stop(guest, "thread-a", { effectiveKill: false })).toEqual(["unknown", "timeout"]);
  });

  it("proves nothing where a command could have run outside its group", () => {
    const guest = fakeGuest();
    // A command of this agent could not be placed.
    writeFileSync(join(guest.run, "aiqsa-agent-untracked-thread-c"), "");
    expect(stop(guest, "thread-c")).toEqual(["unknown", "untracked"]);
    // A live command that came without an agent.
    const child = strippedChild();
    guest.group("_unattributed", [child.pid!]);
    expect(stop(guest, "thread-d")).toEqual(["unknown", "unattributed"]);
    expect(stop(guest, "_unattributed")).toEqual(["unknown", "invalid"]);
    // No cgroup v2, or no cgroup.kill.
    const bare = fakeGuest();
    rmSync(join(bare.cgroot, "cgroup.controllers"));
    expect(stop(bare, "thread-e")).toEqual(["unknown", "cgroup_unavailable"]);
    const old = fakeGuest();
    rmSync(join(old.group("thread-f", []), "cgroup.kill"));
    expect(stop(old, "thread-f")).toEqual(["unknown", "cgroup_kill_unavailable"]);
  });

  it("proves an agent that never ran a command closed", () => {
    expect(stop(fakeGuest(), "nobody-ran")).toEqual(["closed", "none"]);
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
