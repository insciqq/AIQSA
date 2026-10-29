import type { BrowserLiveChannelRequest } from "./browserLive";
import { FRAME_DATA } from "./browserLive.testFixtures";
import type { WorkspaceBrowserLiveReply } from "./runtime";

type Exec = { agent: string; chunks: string[]; done: boolean; frames: boolean; id: string };

export type FakeBrowsingAgent = {
  acted: number;
  controller: "agent" | "user";
  handoff: boolean;
  id: string;
  name: string | null;
  page: { title: string; url: string } | null;
};

/**
 * A per-agent guest (live protocol 2, `ops/workspace-guest/python/aiqsa/browser/_livehub.py`) behind a run's
 * channel: it lists the browsing agents, streams the agent each streamer selected, and applies control, input and
 * handoffs to the agent they name (the main agent when absent). `agents` are the agents browsing now.
 */
export function fakeAgentsGuest(agents: readonly Omit<FakeBrowsingAgent, "controller" | "handoff">[]) {
  const execs = new Map<string, Exec>();
  const received: Record<string, unknown>[] = [];
  const browsing = new Map<string, FakeBrowsingAgent>(agents.map((agent) => [agent.id, { ...agent, controller: "agent", handoff: false }]));
  let next = 0;
  let seq = 0;
  const line = (exec: Exec, message: Readonly<Record<string, unknown>>) => {
    const text = JSON.stringify(message);
    exec.chunks.push(`@${text.length} ${text}\n`);
  };
  const listed = () => ({ agents: [...browsing.values()].map((agent) => ({ acted: agent.acted, agent: agent.id,
    controller: agent.controller, handoff: agent.handoff, name: agent.name, page: agent.page })), t: "agents" });
  const view = (exec: Exec) => {
    const agent = browsing.get(exec.agent);
    line(exec, { agent: exec.agent, browser: "running", controller: agent?.controller ?? "agent", handoff: agent?.handoff ?? false,
      page: agent?.page ?? null, t: "state" });
    line(exec, { agent: exec.agent, steps: [{ action: "open", host: "shop.example", n: 1, path: `/${exec.agent}`, target: "" }],
      t: "steps" });
  };
  const broadcast = () => {
    for (const exec of execs.values()) {
      if (exec.done) continue;
      line(exec, listed());
      view(exec);
    }
  };
  const frameOf = (exec: Exec, agent: string) => {
    seq += 1;
    line(exec, { agent, data: FRAME_DATA, height: 800, seq, t: "frame", width: 1280 });
  };
  const command = (exec: Exec, message: Record<string, unknown>) => {
    received.push(message);
    const agentId = typeof message.agent === "string" ? message.agent : "main";
    const agent = browsing.get(agentId);
    const ack = (extra: Record<string, unknown> = {}) => {
      if (typeof message.id === "string") line(exec, { id: message.id, ok: true, t: "ack", ...extra });
    };
    const refuse = (code: string) => {
      if (typeof message.id === "string") line(exec, { code, id: message.id, ok: false, t: "ack" });
    };
    switch (message.t) {
      case "frames":
        exec.frames = message.on === true;
        if (exec.frames) frameOf(exec, exec.agent);
        return undefined;
      case "select":
        exec.agent = agentId;
        view(exec);
        if (exec.frames) frameOf(exec, exec.agent);
        return undefined;
      case "control":
        if (!agent) return refuse("no_page");
        if (agent.handoff && message.action === "return") return refuse("handoff_pending");
        agent.controller = message.action === "take" ? "user" : "agent";
        broadcast();
        return ack();
      case "handoff":
        if (!agent?.page) return refuse("no_page");
        if (message.action === "begin") {
          agent.handoff = true;
          agent.controller = "user";
          broadcast();
          return ack();
        }
        agent.handoff = false;
        agent.controller = "agent";
        broadcast();
        return ack({ page: agent.page, saved: message.outcome === "completed" && message.reason === "sign_in" ? agentId : null });
      case "input":
        if (agent?.controller !== "user") return refuse("not_in_control");
        return ack();
      default:
        return refuse("message_invalid");
    }
  };
  async function channel(request: BrowserLiveChannelRequest): Promise<WorkspaceBrowserLiveReply> {
    switch (request.action) {
      case "start": {
        const id = `exec-${next++}`;
        const exec: Exec = { agent: "main", chunks: [], done: false, frames: false, id };
        execs.set(id, exec);
        line(exec, listed());
        for (const text of request.stdin.split("\n").filter(Boolean)) command(exec, JSON.parse(text) as Record<string, unknown>);
        view(exec);
        return { action: "start", execSessionId: id };
      }
      case "poll": {
        const exec = execs.get(request.execSessionId);
        if (!exec) throw Object.assign(new Error("workspace_runtime_incompatible"), { code: "workspace_runtime_incompatible" });
        const chunks = exec.chunks.splice(0);
        if (chunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: "poll", chunks, done: exec.done && chunks.length === 0, nextCursor: request.cursor + chunks.length, truncated: false };
      }
      case "write": {
        const exec = execs.get(request.execSessionId);
        if (!exec || exec.done) throw Object.assign(new Error("workspace_runtime_incompatible"), { code: "workspace_runtime_incompatible" });
        for (const text of request.data.split("\n").filter(Boolean)) command(exec, JSON.parse(text) as Record<string, unknown>);
        return { action: "write" };
      }
      case "close": {
        const exec = execs.get(request.execSessionId);
        if (exec) exec.done = true;
        return { action: "close", exited: true };
      }
    }
  }
  return {
    browsing,
    channel,
    received,
    /** A frame of one agent's tab on every streamer, as a stale or a foreign one would arrive. */
    frameOf(agent: string) { for (const exec of execs.values()) if (!exec.done && exec.frames) frameOf(exec, agent); },
    /** The agents change (one acts, leaves or starts); every streamer gets the new list. */
    update(change: (agents: Map<string, FakeBrowsingAgent>) => void) {
      change(browsing);
      broadcast();
    },
    /** What each running streamer streams. */
    selections: () => [...execs.values()].filter((exec) => !exec.done).map((exec) => exec.agent)
  };
}
