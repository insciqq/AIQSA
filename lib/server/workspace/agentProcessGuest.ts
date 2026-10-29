import { WORKSPACE_AGENT_PROTOCOL } from "@/lib/server/subagents/guestProtocol";

/** One agent's processes stopped in a shared guest (`terminateAgentProcesses`). Never carries guest output. */
export type WorkspaceAgentProcessTermination = Readonly<{ outcome: "closed" | "unknown" }>;

/** The whole helper, its cgroup proof included, ends well inside this bound or it reports nothing proven. */
export const WORKSPACE_AGENT_STOP_TIMEOUT_MS = 12_000;
/** How long the helper gathers, kills and waits before it gives up as `unknown`. */
const AGENT_STOP_SETTLE_SECONDS = 8;
const AGENT_ID = new RegExp(WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN, "u");

/** The agent id a stop names: the guest protocol's (`main` or a thread id); anything else is a defect. */
export function workspaceAgentStopRequest(agentId: string): Buffer {
  if (!AGENT_ID.test(agentId)) throw new Error("workspace_agent_identity_invalid");
  return Buffer.from(JSON.stringify({ agentId }) + "\n");
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
 * Stops every guest process of one agent of a shared Workspace, with proof, and nothing of the other agents.
 * Every exec call carries the server-set agent id (`AIQSA_AGENT_ID`, `guestProtocol.ts`); the helper moves each
 * process whose start environment names that agent into a fresh cgroup, until a scan finds none outside it
 * (children forked meanwhile inherit the environment, so the next scan finds them), then writes `cgroup.kill`
 * and waits until `cgroup.procs` is empty. `closed` means that group emptied and no process of the agent is left.
 * No cgroup v2 with `cgroup.kill`, a refused move, or the deadline answers `unknown`, and the caller stops the VM.
 *
 * A coordination key, not a security boundary (`agents.py`): a process started with the variable removed from
 * its environment, before it was moved, is not found. Processes shared by every agent (the browser host) must
 * be started without the agent id. Fixed code from the server, needing no guest image change; the request on
 * stdin is the agent id only.
 */
export const WORKSPACE_AGENT_STOP_GUEST_SCRIPT = String.raw`
import json, os, re, secrets, sys, time

ENV = b'${WORKSPACE_AGENT_PROTOCOL.AGENT_ID_ENV}='
PATTERN = re.compile(r'${WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN}')
SETTLE = ${AGENT_STOP_SETTLE_SECONDS}

def agent_pids(proc, agent, exclude):
    needle = ENV + agent.encode('ascii')
    found = []
    for name in os.listdir(proc):
        if not name.isdigit() or int(name) in exclude:
            continue
        try:
            with open(os.path.join(proc, name, 'environ'), 'rb') as handle:
                data = handle.read(1 << 20)
        except OSError:
            continue
        if needle in data.split(b'\0'):
            found.append(int(name))
    return found

def cgroup_of(proc, pid):
    try:
        with open(os.path.join(proc, str(pid), 'cgroup'), 'r') as handle:
            for line in handle:
                if line.startswith('0::'):
                    return line[3:].strip()
    except OSError:
        return None
    return None

def read_procs(group):
    with open(os.path.join(group, 'cgroup.procs'), 'r') as handle:
        return handle.read().split()

def stop(proc, cgroot, agent, clock=time.monotonic, pause=time.sleep):
    if not PATTERN.fullmatch(agent):
        return 'unknown', 'invalid'
    exclude = {os.getpid(), os.getppid()}
    if not agent_pids(proc, agent, exclude):
        return 'closed', 'none'
    if not os.path.exists(os.path.join(cgroot, 'cgroup.controllers')):
        return 'unknown', 'cgroup_unavailable'
    name = 'aiqsa-agent-stop-' + secrets.token_hex(6)
    group = os.path.join(cgroot, name)
    try:
        os.mkdir(group, 0o700)
    except OSError:
        return 'unknown', 'cgroup_unavailable'
    try:
        if not os.path.exists(os.path.join(group, 'cgroup.kill')):
            return 'unknown', 'cgroup_kill_unavailable'
        deadline = clock() + SETTLE
        while True:
            outside = [pid for pid in agent_pids(proc, agent, exclude) if cgroup_of(proc, pid) != '/' + name]
            if not outside:
                break
            if clock() > deadline:
                return 'unknown', 'timeout'
            for pid in outside:
                try:
                    with open(os.path.join(group, 'cgroup.procs'), 'w') as handle:
                        handle.write(str(pid))
                except ProcessLookupError:
                    continue
                except OSError:
                    if os.path.exists(os.path.join(proc, str(pid))):
                        return 'unknown', 'move_refused'
        with open(os.path.join(group, 'cgroup.kill'), 'w') as handle:
            handle.write('1')
        while read_procs(group):
            if clock() > deadline:
                return 'unknown', 'timeout'
            pause(0.02)
        if agent_pids(proc, agent, exclude):
            return 'unknown', 'survivor'
        return 'closed', 'killed'
    except OSError:
        return 'unknown', 'failed'
    finally:
        try:
            os.rmdir(group)
        except OSError:
            pass

def main():
    try:
        request = json.loads(sys.stdin.read(512))
        agent = request['agentId'] if isinstance(request, dict) else None
        if not isinstance(agent, str):
            raise ValueError()
        outcome, code = stop('/proc', '/sys/fs/cgroup', agent)
    except Exception:
        outcome, code = 'unknown', 'failed'
    sys.stdout.write(json.dumps({'outcome': outcome, 'code': code}) + '\n')

if __name__ == '__main__':
    main()
`;
