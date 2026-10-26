import type { BrowserLiveChannelRequest, BrowserLiveWriter } from "./browserLive";
import type { WorkspaceBrowserLiveReply } from "./runtime";

/** A small JPEG's base64 as the guest's screencast sends it (only its SOI prefix is checked). */
export const FRAME_DATA = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR8eHR8eHR8e";

type Exec = { chunks: string[]; done: boolean; frames: boolean };

/**
 * The guest's live-view streamer behind a run's channel, as `aiqsa.browser.live` and the host answer it: state,
 * steps and frames on demand, acknowledged commands, applied input. `page` is what the browser shows.
 */
export function fakeLiveGuest(options: Readonly<{ browser?: boolean; silent?: boolean }> = {}) {
  const execs = new Map<string, Exec>();
  const received: Record<string, unknown>[] = [];
  const guest = { browser: options.browser ?? true, controller: "agent", frameSeq: 0, handoff: false,
    page: { title: "Sign in", url: "https://shop.example/login" } };
  let next = 0;
  let failing: string | null = null;
  const line = (exec: Exec, message: Readonly<Record<string, unknown>>) => {
    if (options.silent) return;
    const text = JSON.stringify(message);
    exec.chunks.push(`@${text.length} ${text}\n`);
  };
  const state = (exec: Exec) => line(exec, guest.browser
    ? { browser: "running", controller: guest.controller, handoff: guest.handoff, page: guest.page, t: "state" }
    : { browser: "absent", t: "state" });
  const broadcast = () => { for (const exec of execs.values()) if (!exec.done) state(exec); };
  const frame = (exec: Exec) => {
    guest.frameSeq += 1;
    line(exec, { data: FRAME_DATA, height: 800, seq: guest.frameSeq, t: "frame", width: 1280 });
  };
  const command = (exec: Exec, message: Record<string, unknown>) => {
    received.push(message);
    const ack = (extra: Record<string, unknown> = {}) => {
      if (typeof message.id === "string") line(exec, { id: message.id, ok: true, t: "ack", ...extra });
    };
    const refuse = (code: string) => {
      if (typeof message.id === "string") line(exec, { code, id: message.id, ok: false, t: "ack" });
    };
    if (!guest.browser && message.t !== "frames" && message.t !== "input") return refuse("browser_not_running");
    switch (message.t) {
      case "frames":
        exec.frames = message.on === true;
        if (exec.frames) frame(exec);
        return undefined;
      case "control":
        if (guest.handoff && message.action === "return") return refuse("handoff_pending");
        guest.controller = message.action === "take" ? "user" : "agent";
        broadcast();
        return ack();
      case "handoff":
        if (message.action === "begin") {
          guest.handoff = true;
          guest.controller = "user";
          broadcast();
          return ack();
        }
        guest.handoff = false;
        guest.controller = "agent";
        broadcast();
        return ack({ page: guest.page, saved: message.outcome === "completed" ? "shop.example" : null });
      case "input":
        if (guest.controller !== "user") return refuse("not_in_control");
        return ack();
      default:
        return refuse("message_invalid");
    }
  };
  async function channel(request: BrowserLiveChannelRequest): Promise<WorkspaceBrowserLiveReply> {
    if (failing) throw Object.assign(new Error(failing), { code: failing });
    switch (request.action) {
      case "start": {
        const id = `exec-${next++}`;
        const exec: Exec = { chunks: [], done: false, frames: false };
        execs.set(id, exec);
        state(exec);
        for (const text of request.stdin.split("\n").filter(Boolean)) command(exec, JSON.parse(text) as Record<string, unknown>);
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
    channel,
    /** Streamers still running. */
    open: () => [...execs.values()].filter((exec) => !exec.done).length,
    received,
    started: () => next,
    guest,
    /** The guest's page changes (a navigation the user or agent made). */
    navigate(url: string, title: string) {
      guest.page = { title, url };
      broadcast();
    },
    /** A new frame on every streamer that wants frames. */
    frame() { for (const exec of execs.values()) if (!exec.done && exec.frames) frame(exec); },
    /** Every channel request fails with this code from now on (null: none). */
    fail(code: string | null) { failing = code; },
    /** The streamer exits by itself (an old guest image without the live view exits at once). */
    exitAll() { for (const exec of execs.values()) exec.done = true; }
  };
}

/** One SSE view as the routes' stream writer is used by the relay: its events in order, and its end. */
export function recordingWriter(options: Readonly<{ refuseFrames?: boolean; refuseState?: boolean }> = {}) {
  const events: { data: unknown; event: string }[] = [];
  let closed: { data: unknown; event: string } | null | undefined;
  const writer: BrowserLiveWriter = {
    close(final) {
      if (closed !== undefined) return;
      closed = final ?? null;
      if (final) events.push(final);
    },
    send(event, data) {
      if (closed !== undefined) return false;
      if ((event === "frame" && options.refuseFrames) || (event === "state" && options.refuseState)) return false;
      events.push({ data, event });
      return true;
    }
  };
  return {
    closed: () => closed,
    events,
    last<T = Record<string, unknown>>(event: string): T | undefined {
      return [...events].reverse().find((entry) => entry.event === event)?.data as T | undefined;
    },
    of(event: string) { return events.filter((entry) => entry.event === event).map((entry) => entry.data); },
    writer
  };
}

/** Resolves once `check` holds, polling the event loop (the relay's pump runs on real timers). */
export async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
