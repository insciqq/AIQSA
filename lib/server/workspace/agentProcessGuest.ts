import { WORKSPACE_AGENT_PROTOCOL } from "@/lib/server/subagents/guestProtocol";

/** One agent's processes stopped in a shared guest (`terminateAgentProcesses`). Never carries guest output. */
export type WorkspaceAgentProcessTermination = Readonly<{ outcome: "closed" | "unknown" }>;

/** The whole helper, its cgroup proof included, ends well inside this bound or it reports nothing proven. */
export const WORKSPACE_AGENT_STOP_TIMEOUT_MS = 12_000;
/** How long the helper waits for the killed group to empty before it gives up as `unknown`. */
const AGENT_STOP_SETTLE_SECONDS = 8;
const AGENT_ID = new RegExp(WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN, "u");
const CGROUP_ROOT = "/sys/fs/cgroup";
/** Where a command that could not be placed in its agent's group leaves its mark (tmpfs: gone with the VM). */
const UNTRACKED_DIRECTORY = "/run";
/**
 * The group of commands that reached the guest without an agent: their processes belong to no agent, so while
 * one lives no agent's stop is proven.
 */
export const WORKSPACE_UNATTRIBUTED_AGENT_ID = "_unattributed";
/** The group every agent shares (the browser host and Chromium): never part of any agent's stop. */
export const WORKSPACE_SHARED_PROCESS_GROUP = "aiqsa-shared";

function agentId(value: string): string {
  if (!AGENT_ID.test(value)) throw new Error("workspace_agent_identity_invalid");
  return value;
}

/** The agent id a stop names: the guest protocol's (`main` or a thread id); anything else is a defect. */
export function workspaceAgentStopRequest(value: string): Buffer {
  return Buffer.from(JSON.stringify({ agentId: agentId(value) }) + "\n");
}

/**
 * Shell lines that put the shell running them (`$$`) into its agent's cgroup before anything else it runs, so
 * every descendant inherits the group whatever environment it starts with. Mounts cgroup v2 when the guest has not.
 * A command that cannot be placed still runs, and leaves the mark that makes its agent's stop `unknown`.
 */
function placementLines(id: string): string {
  const group = `${CGROUP_ROOT}/aiqsa-agent-${agentId(id)}`;
  return [
    `[ -f ${CGROUP_ROOT}/cgroup.controllers ] || mount -t cgroup2 none ${CGROUP_ROOT} 2>/dev/null`,
    // Never a special built-in (`:`): its failed redirection would end a POSIX shell before the command runs.
    `{ mkdir -p ${group} && [ -f ${group}/cgroup.kill ] && echo $$ > ${group}/cgroup.procs; } 2>/dev/null || ` +
      `{ true > ${UNTRACKED_DIRECTORY}/aiqsa-agent-untracked-${id}; } 2>/dev/null || true`
  ].join("\n");
}

/**
 * The arguments of one exec call, with its command started inside its agent's cgroup (a fixed launcher prefix the
 * model never writes). A shell command runs its own lines after the placement in the same shell; a direct exec runs
 * as `exec "$@"` behind it, so argv, exit code and output are the command's own. Other tools are returned as given.
 */
export function workspaceAgentLaunchArguments(
  originalName: string, args: Readonly<Record<string, unknown>>, agent: string
): Record<string, unknown> {
  if (originalName === "sandbox_shell") {
    return typeof args.command === "string" ? { ...args, command: `${placementLines(agent)}\n${args.command}` } : { ...args };
  }
  if (originalName !== "sandbox_exec" && originalName !== "sandbox_exec_start") return { ...args };
  const rest = args.args === undefined ? [] : args.args;
  if (typeof args.command !== "string" || !Array.isArray(rest) || rest.some((entry) => typeof entry !== "string")) {
    // The tool refuses a malformed call by itself; nothing runs to place.
    return { ...args };
  }
  return { ...args, args: ["-c", `${placementLines(agent)}\nexec "$@"`, "aiqsa-agent", args.command, ...rest as string[]], command: "/bin/sh" };
}

/** Reads the helper's one line; anything else proves nothing. */
export function parseWorkspaceAgentStopOutcome(stdout: string): WorkspaceAgentProcessTermination {
  const line = stdout.trim();
  if (line.length === 0 || line.length > 256 || line.includes("\n")) return { outcome: "unknown" };
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && (value as Record<string, unknown>).outcome === "closed"
      ? { outcome: "closed" } : { outcome: "unknown" };
  } catch {
    return { outcome: "unknown" };
  }
}

/**
 * Stops every guest process of one agent of a shared Workspace, with proof, and nothing of the other agents. Every
 * exec of an agent starts inside `aiqsa-agent-<id>` (`workspaceAgentLaunchArguments`), and a process cannot leave its
 * cgroup by changing its environment, so the stop is that group's `cgroup.kill`, proven once `cgroup.procs` is empty.
 * `unknown` when anything could escape the proof: a command that could not be placed (its mark), a live command
 * without an agent, no cgroup v2 with `cgroup.kill`, or the deadline. Processes every agent shares (the browser host)
 * live in `aiqsa-shared` and are never touched. A coordination key, not a security boundary: root guest code could
 * move itself out of its group. Fixed code from the server, needing no guest image change; stdin is the agent id.
 */
export const WORKSPACE_AGENT_STOP_GUEST_SCRIPT = String.raw`
import json, os, re, subprocess, sys, time

PATTERN = re.compile(r'${WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN}')
UNATTRIBUTED = '${WORKSPACE_UNATTRIBUTED_AGENT_ID}'
SETTLE = ${AGENT_STOP_SETTLE_SECONDS}

def members(group):
    with open(os.path.join(group, 'cgroup.procs'), 'r') as handle:
        return handle.read().split()

def stop(cgroot, run_dir, agent, clock=time.monotonic, pause=time.sleep):
    if not PATTERN.fullmatch(agent) or agent == UNATTRIBUTED:
        return 'unknown', 'invalid'
    if os.path.lexists(os.path.join(run_dir, 'aiqsa-agent-untracked-' + agent)):
        return 'unknown', 'untracked'
    if not os.path.isdir(run_dir) or not os.access(run_dir, os.W_OK):
        return 'unknown', 'untracked_unprovable'
    if not os.path.exists(os.path.join(cgroot, 'cgroup.controllers')):
        return 'unknown', 'cgroup_unavailable'
    try:
        unattributed = os.path.join(cgroot, 'aiqsa-agent-' + UNATTRIBUTED)
        if os.path.isdir(unattributed) and members(unattributed):
            return 'unknown', 'unattributed'
        group = os.path.join(cgroot, 'aiqsa-agent-' + agent)
        if not os.path.isdir(group):
            # Every command of the agent was placed here or left its mark: none ever ran.
            return 'closed', 'none'
        if not os.path.exists(os.path.join(group, 'cgroup.kill')):
            return 'unknown', 'cgroup_kill_unavailable'
        deadline = clock() + SETTLE
        with open(os.path.join(group, 'cgroup.kill'), 'w') as handle:
            handle.write('1')
        while members(group):
            if clock() > deadline:
                return 'unknown', 'timeout'
            pause(0.02)
        try:
            os.rmdir(group)
        except OSError:
            pass
        return 'closed', 'killed'
    except OSError:
        return 'unknown', 'failed'

def mount_cgroup2(cgroot):
    if os.path.exists(os.path.join(cgroot, 'cgroup.controllers')):
        return
    try:
        subprocess.run(['mount', '-t', 'cgroup2', 'none', cgroot], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=3, check=False)
    except (OSError, subprocess.SubprocessError):
        pass

def main():
    try:
        request = json.loads(sys.stdin.read(512))
        agent = request['agentId'] if isinstance(request, dict) else None
        if not isinstance(agent, str):
            raise ValueError()
        mount_cgroup2('${CGROUP_ROOT}')
        outcome, code = stop('${CGROUP_ROOT}', '${UNTRACKED_DIRECTORY}', agent)
    except Exception:
        outcome, code = 'unknown', 'failed'
    sys.stdout.write(json.dumps({'outcome': outcome, 'code': code}) + '\n')

if __name__ == '__main__':
    main()
`;
