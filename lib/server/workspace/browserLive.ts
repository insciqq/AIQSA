import { randomBytes, randomUUID } from "node:crypto";
import {
  BROWSER_LIVE_LIMITS,
  BROWSER_LIVE_MAIN_AGENT,
  BROWSER_LIVE_PROTOCOL_VERSION,
  browserLiveFrameEventSchema,
  browserLiveStateEventSchema,
  browserLiveStepsEventSchema,
  type BrowserHandoffOutcome,
  type BrowserHandoffReason,
  type BrowserLiveAgentRef,
  type BrowserLiveControlRequest,
  type BrowserLiveEndReason,
  type BrowserLiveErrorCode,
  type BrowserLiveFrameEvent,
  type BrowserLiveHandoffRequest,
  type BrowserLiveInput,
  type BrowserLiveStateEvent,
  type BrowserLiveStep
} from "@/lib/contracts/browserLive";
import { logEvent } from "../observability";
import { WORKSPACE_AGENT_PROTOCOL } from "../subagents/guestProtocol";
import { BROWSER_LIVE_MAIN_REF, BrowserLiveAgents, browserLivePage, guestMessageAgent } from "./browserLiveAgents";
import type { WorkspaceBrowserLiveAction, WorkspaceBrowserLiveReply } from "./runtime";

/**
 * The live Workspace browser (`lib/contracts/browserLive.ts`, operator decisions 2026-10-26): while a run's
 * browser is open, its owner's chat watches it, takes control, and answers a handoff the agent asked for.
 *
 * Everything here lives in this process's memory and nowhere else: frames, steps, the page's address and the
 * user's input pass through and are never stored, logged or shown to the model, which learns only a handoff's
 * outcome and page (`browserHandoff.ts`). The engine registers each interactive web run with a Workspace when
 * it starts and ends it before the Workspace hands off or settles, so no view or streamer outlives its turn.
 *
 * Transport (task decision 2026-10-26, measured over the exec channel): a guest streamer
 * (`aiqsa.browser.live`) started through the run's own channel under its operation (`browserLiveChannel.ts`),
 * polled back to back while it prints and every `idlePollMs` otherwise, keeping only the latest frame. It runs
 * only while a view is open or a command needs it, and is rotated before the pinned MCP's in-memory output
 * history grows large; a command waits for a fresh streamer's first report.
 *
 * Control is this server's record, set only by the owner's authenticated Take and Return and by the pending
 * handoff: agent code shares the guest, so a guest report may hand control back to the agent (its grace ended, its
 * host restarted) but never give it to the user. The guest enforces the same control for the agent's actions.
 *
 * Several agents (the main agent and its sub-agents) browse one shared browser, each in its own tabs: control,
 * handoffs and selection are per agent (`browserLiveAgents.ts`), the streamer streams the selected agent's tab, and
 * one owner check covers every agent's stream and input, since they are one run's live browser.
 *
 * The relay is one object per process (`globalThis`), shared by the engine's bundle and the routes', so its code
 * never relies on `instanceof` across bundles: failures are read by their `code`.
 */

export const BROWSER_LIVE_RELAY_LIMITS = Object.freeze({
  /** A streamer that printed nothing is polled again after this. */
  idlePollMs: 25,
  /** A streamer is replaced after this much output or this long, so the MCP's output history stays bounded. */
  rotateChars: 16 * 1_024 * 1_024,
  rotateMs: 4 * 60_000,
  /** A streamer outlives its last view this long: a reloading page keeps it. */
  lingerMs: 5_000,
  /** How long a command waits for the guest's answer. */
  commandMs: 10_000,
  /** How long a command waits for a fresh streamer's first report (it has reached the host, or found none). */
  firstStateMs: 2_000,
  /** Views of one run; another one ends the oldest with `replaced`. */
  views: 4,
  /** Failed polls in a row that end a streamer. */
  pollFailures: 5,
  /** After the guest could not be reached, an open view tries again this much later, at most `retries` times. */
  retryMs: 2_000,
  retries: 30,
  /** Bytes of one view's SSE queue (a few frames); a view that falls behind loses frames, never state. */
  viewQueueBytes: 4 * 1_024 * 1_024,
  /** How long the end of a run waits for its streamer to close. */
  endMs: 3_000
});

const MAX_LINE_CHARS = BROWSER_LIVE_LIMITS.frameBase64Chars + 64 * 1_024;

/** One request of the run's live channel, without the identity and operation its owner adds. */
export type BrowserLiveChannelRequest = WorkspaceBrowserLiveAction;

export type BrowserLiveRegistration = Readonly<{
  /** The run's own live channel (`WorkspaceCoordinator.browserLive`); throws `workspace_session_lost` before its guest runs. */
  channel(request: BrowserLiveChannelRequest): Promise<WorkspaceBrowserLiveReply>;
  chatId: string;
  runId: string;
  /** Whether a sign-in made in this browser is saved to the owner's Secrets after the turn (asked once, lazily). */
  signInRemembered(): Promise<boolean>;
  userId: string;
}>;

/** A signed-in browser session of the run's owner. */
export type BrowserLiveViewer = Readonly<{ authSessionId: string; userId: string }>;

/** One SSE stream; `send` is false once it is closed or its queue is full. */
export type BrowserLiveWriter = Readonly<{
  close(final?: Readonly<{ data: unknown; event: string }>): void;
  send(event: string, data: unknown): boolean;
}>;

export type BrowserLiveHandoffResult =
  | Readonly<{ kind: "ended"; outcome: BrowserHandoffOutcome; page: Readonly<{ title: string; url: string }> | null; saved: string | null }>
  /** No tab is open in the run's browser (the agent has not opened a page). */
  | Readonly<{ kind: "no_browser" }>
  /** Another handoff of the same agent is waiting. */
  | Readonly<{ kind: "busy" }>
  /** The live channel cannot reach this run's browser: a runtime or guest image without it, or a stopped guest. */
  | Readonly<{ kind: "unavailable" }>;

/** One agent's handoff: `agent` is the asking agent (the main agent when absent), whose tab the user is given. */
export type BrowserLiveHandoffInput = Readonly<{
  agent?: BrowserLiveAgentRef;
  message: string;
  reason: BrowserHandoffReason;
  signal: AbortSignal;
  waitMs: number;
}>;

/** What the engine holds of its run. */
export type BrowserLiveRunHandle = Readonly<{
  end(reason?: Extract<BrowserLiveEndReason, "browser_stopped" | "run_finished">): Promise<void>;
  handoff(input: BrowserLiveHandoffInput): Promise<BrowserLiveHandoffResult>;
}>;

type GuestMessage = Readonly<Record<string, unknown>>;
type Ack = Readonly<{ ok?: unknown; code?: unknown; page?: unknown; saved?: unknown }>;
const AGENT_FIELD = WORKSPACE_AGENT_PROTOCOL.LIVE_AGENT_FIELD;

class Streamer {
  buffer = "";
  chars = 0;
  closed = false;
  closing: Promise<void> | null = null;
  cursor = 0;
  /** It printed a message: it runs on a guest that has the live view. */
  printed = false;
  /** Being replaced (`rotate`): nothing new is sent through it. */
  retiring = false;
  /** Its first `state` arrived: its first attempt to reach the guest's host has resolved. */
  reported = false;
  readonly firstState: Promise<void>;
  readonly startedAt = Date.now();
  readonly waiters = new Map<string, (ack: Ack) => void>();
  private announce: () => void = () => undefined;

  constructor(readonly execSessionId: string, public frames: boolean) {
    this.firstState = new Promise<void>((resolve) => { this.announce = resolve; });
  }

  stated(): void {
    if (this.reported) return;
    this.reported = true;
    this.announce();
  }
}

function failureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown";
}

/** The guest is not (or no longer) running for this run: an open view waits for it. */
const GUEST_GONE = new Set(["workspace_session_lost", "workspace_operation_stale"]);
/** The run's runtime has no live channel. */
const NO_CHANNEL = new Set(["workspace_runtime_incompatible"]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** One `@<length> <json>` line of the streamer (`_live.encode_line`); null for a cut or foreign line. */
export function decodeBrowserLiveLine(line: string): GuestMessage | null {
  if (!line.startsWith("@")) return null;
  const space = line.indexOf(" ");
  if (space < 2 || space > 9) return null;
  const length = Number(line.slice(1, space));
  const text = line.slice(space + 1);
  if (!Number.isSafeInteger(length) || text.length !== length) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as GuestMessage : null;
  } catch {
    return null;
  }
}

const pageOf = browserLivePage;

function streamerLine(message: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(message) + "\n";
}

class LiveRun implements BrowserLiveRunHandle {
  browser: BrowserLiveStateEvent["browser"] = "absent";
  ended = false;
  /** The browsing agents, control and handoffs per agent, and the agent the stream shows. */
  private readonly agents = new BrowserLiveAgents();
  private ending: Promise<void> | null = null;
  /** The latest frame of the selected agent's tab. */
  private frame: BrowserLiveFrameEvent | null = null;
  private inputs = new Map<string, number[]>();
  private linger: ReturnType<typeof setTimeout> | null = null;
  private remembered: boolean | null = null;
  private retries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<Streamer> | null = null;
  /** The newest steps of the selected agent. */
  private steps: BrowserLiveStep[] | null = null;
  private streamer: Streamer | null = null;
  /** Without a live view in this guest image or runtime: nothing is started again. */
  private unavailable = false;
  private readonly views = new Map<string, Readonly<{ viewer: BrowserLiveViewer; writer: BrowserLiveWriter }>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly registration: BrowserLiveRegistration, private readonly forget: () => void) {}

  // Views ---------------------------------------------------------------------------------------------------------

  /** Opens one view of the owner: the state, the steps and the latest frame now, then every change. */
  async watch(viewer: BrowserLiveViewer, writer: BrowserLiveWriter): Promise<string | null> {
    if (this.remembered === null) this.remembered = await this.registration.signInRemembered().catch(() => false);
    if (this.ended) return null;
    if (this.unavailable) {
      writer.close({ data: { reason: "not_available" }, event: "end" });
      return null;
    }
    while (this.views.size >= BROWSER_LIVE_RELAY_LIMITS.views) {
      const [oldestId, oldest] = this.views.entries().next().value!;
      this.views.delete(oldestId);
      oldest.writer.close({ data: { reason: "replaced" }, event: "end" });
    }
    // The panel opens on the agent that needs the user, or the one that acted last, unless the owner chose one.
    if (this.views.size === 0 && this.agents.viewOpened()) this.selectionMoved();
    const id = randomUUID();
    this.views.set(id, { viewer, writer });
    if (!writer.send("state", this.stateEvent()) || (this.steps && !writer.send("steps", { agent: this.agents.selected, steps: this.steps }))) {
      this.views.delete(id);
      writer.close();
      return null;
    }
    if (this.frame) writer.send("frame", this.frame);
    this.clearLinger();
    void this.wantFrames();
    return id;
  }

  unwatch(id: string): void {
    if (!this.views.delete(id) || this.views.size > 0) return;
    // No view wants frames now; the streamer itself lingers for a reloading page.
    const streamer = this.streamer;
    if (streamer && !streamer.closed && streamer.frames) {
      streamer.frames = false;
      void this.write(streamer, { on: false, t: "frames" }).catch(() => undefined);
    }
    this.scheduleLinger();
  }

  /** One input from the owner into the agent's tab it names, in arrival order, only while the user holds that tab. */
  async input(viewer: BrowserLiveViewer, input: BrowserLiveInput): Promise<BrowserLiveErrorCode | null> {
    if (this.ended) return "browser_live_not_found";
    if (!this.allow(viewer.userId)) return "browser_live_rate_limited";
    const { agent = BROWSER_LIVE_MAIN_AGENT, ...event } = input;
    if (!this.agents.userControls(agent)) return "browser_live_not_in_control";
    const streamer = this.streamer;
    if (!streamer || streamer.closed) return "browser_live_unavailable";
    try {
      await this.write(streamer, { [AGENT_FIELD]: agent, input: event, t: "input" });
    } catch {
      return "browser_live_unavailable";
    }
    return null;
  }

  /**
   * Take control or Return control of one agent's tab (watch mode; a pending handoff is answered with Done or Cancel
   * instead), or the agent whose tab the stream shows.
   */
  async control(_viewer: BrowserLiveViewer, request: BrowserLiveControlRequest | BrowserLiveControlRequest["action"]):
    Promise<BrowserLiveErrorCode | null> {
    if (this.ended) return "browser_live_not_found";
    const asked: Readonly<{ action: BrowserLiveControlRequest["action"]; agent?: string }> =
      typeof request === "string" ? { action: request } : request;
    const agent = asked.agent ?? BROWSER_LIVE_MAIN_AGENT;
    if (asked.action === "select") {
      const selected = this.agents.select(agent);
      if (!selected.ok) return "browser_live_unavailable";
      if (selected.changed) this.selectionMoved();
      return null;
    }
    const action = asked.action;
    if (this.agents.pendingOf(agent)) return action === "take" ? null : "browser_live_unavailable";
    if (this.browser !== "running" || !this.agents.browsing(agent)) return "browser_live_unavailable";
    const ack = await this.command({ action, [AGENT_FIELD]: agent, t: "control" }).catch(() => null);
    if (ack?.ok !== true) return "browser_live_unavailable";
    this.agents.setTaken(agent, action === "take");
    this.broadcastState();
    return null;
  }

  /** Done or Cancel on the pending handoff it names, whichever agent asked; an ended one is stale. */
  answerHandoff(_viewer: BrowserLiveViewer, request: BrowserLiveHandoffRequest): BrowserLiveErrorCode | null {
    if (this.ended) return "browser_live_not_found";
    const pending = this.agents.pending(request.handoffId);
    if (!pending) return "browser_live_handoff_stale";
    pending.resolve(request.action === "done" ? "completed" : "cancelled");
    return null;
  }

  // The engine ----------------------------------------------------------------------------------------------------

  /**
   * An agent's handoff: the user holds that agent's tab until Done, Cancel or `waitMs`, while the other agents go on;
   * the run's Stop or deadline (`signal`) ends it too, by throwing its reason. Each agent has at most one pending, and
   * the panel shows the oldest first. On Done the guest saves the site of that agent's tab, only for a handoff about
   * signing in (sign-in, code, check, consent; operator decision 2026-10-27): the end carries the reason.
   */
  async handoff(input: BrowserLiveHandoffInput): Promise<BrowserLiveHandoffResult> {
    input.signal.throwIfAborted();
    const agent = input.agent ?? BROWSER_LIVE_MAIN_REF;
    if (this.ended || this.unavailable) return { kind: "unavailable" };
    if (this.agents.handoffBusy(agent.id)) return { kind: "busy" };
    this.agents.beginStarting(agent.id);
    try {
      const begin = await this.command({ action: "begin", [AGENT_FIELD]: agent.id, t: "handoff" });
      // `no_page`: the agent has no tab. Anything else, `browser_not_running` (no host answered) included, is a
      // browser the user cannot be shown now.
      if (begin.ok !== true) return begin.code === "no_page" ? { kind: "no_browser" } : { kind: "unavailable" };
    } catch (error) {
      return GUEST_GONE.has(failureCode(error)) ? { kind: "no_browser" } : { kind: "unavailable" };
    } finally {
      this.agents.endStarting(agent.id);
    }
    const startedAt = Date.now();
    const id = `handoff_${randomBytes(12).toString("base64url")}`;
    const outcome = await new Promise<BrowserHandoffOutcome | "aborted">((resolve) => {
      let settled = false;
      const finish = (value: BrowserHandoffOutcome | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timed_out"), input.waitMs);
      const onAbort = () => finish("aborted");
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (this.agents.addHandoff({ agent, expiresAt: startedAt + input.waitMs, id, message: input.message, reason: input.reason,
        resolve: finish, startedAt })) this.selectionMoved();
      else this.broadcastState();
      if (input.signal.aborted) finish("aborted");
    });
    const before = this.agents.selected;
    this.agents.removeHandoff(id);
    if (this.agents.selected !== before) this.selectionMoved();
    else this.broadcastState();
    if (outcome === "aborted") {
      // The run is ending: its guest stops with it, so the guest's control is ended without waiting.
      void this.command({ action: "end", [AGENT_FIELD]: agent.id, outcome: "cancelled", reason: input.reason, t: "handoff" }, 2_000)
        .catch(() => undefined);
      throw input.signal.reason ?? new Error("browser_handoff_aborted");
    }
    const ending = { action: "end", [AGENT_FIELD]: agent.id, outcome, reason: input.reason, t: "handoff" };
    let end = await this.command(ending).catch(() => null);
    if (end?.ok !== true && !this.ended) {
      // Once more on a fresh streamer: the guest's control must not stay with the user for the rest of the turn.
      const missed = this.streamer;
      if (missed) await this.close(missed);
      end = await this.command(ending).catch(() => null);
    }
    return { kind: "ended", outcome, page: end?.ok === true ? pageOf(end.page) : null,
      saved: end?.ok === true && typeof end.saved === "string" ? end.saved.slice(0, 200) : null };
  }

  /** The run's turn ended: views end with `reason` and the streamer goes, before the Workspace hands off or settles. */
  end(reason: Extract<BrowserLiveEndReason, "browser_stopped" | "run_finished"> = "run_finished"): Promise<void> {
    if (this.ending) return this.ending;
    this.ended = true;
    // Handoffs still waiting end with the run: their calls return `timed_out` instead of waiting out their time.
    for (const pending of this.agents.drainHandoffs()) pending.resolve("timed_out");
    this.browser = "stopped";
    this.agents.clearBrowsing();
    this.clearLinger();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const state = this.stateEvent();
    for (const { writer } of this.views.values()) {
      writer.send("state", state);
      writer.close({ data: { reason }, event: "end" });
    }
    this.views.clear();
    this.forget();
    const streamer = this.streamer;
    this.ending = Promise.race([
      streamer ? this.close(streamer) : Promise.resolve(),
      delay(BROWSER_LIVE_RELAY_LIMITS.endMs)
    ]);
    return this.ending;
  }

  // State ---------------------------------------------------------------------------------------------------------

  private stateEvent(): BrowserLiveStateEvent {
    const event: BrowserLiveStateEvent = {
      ...this.agents.project(),
      browser: this.browser,
      runId: this.registration.runId,
      signInRemembered: this.remembered === true,
      version: BROWSER_LIVE_PROTOCOL_VERSION
    };
    if (browserLiveStateEventSchema.safeParse(event).success) return event;
    // A bounded guest report that still does not fit shows no page; control and handoffs are the server's own.
    return { ...event, agents: event.agents.map((agent) => ({ ...agent, page: null })), page: null };
  }

  /**
   * The stream now shows another agent: the old agent's frame and steps go, views learn the selection, and the
   * guest streams the new agent's tab (a streamer started later carries it from the start).
   */
  private selectionMoved(): void {
    this.frame = null;
    this.steps = null;
    this.broadcastState();
    if (!this.ended) this.broadcast("steps", { agent: this.agents.selected, steps: [] });
    const streamer = this.streamer;
    if (streamer && !streamer.closed && !streamer.retiring) {
      void this.write(streamer, { [AGENT_FIELD]: this.agents.selected, t: WORKSPACE_AGENT_PROTOCOL.LIVE_SELECT_MESSAGE })
        .catch(() => undefined);
    }
  }

  private broadcast(event: "frame" | "state" | "steps", data: unknown): void {
    for (const [id, view] of this.views) {
      if (view.writer.send(event, data) || event === "frame") continue;
      // A view that cannot take the state anymore is ended; it may reopen.
      this.views.delete(id);
      view.writer.close({ data: { reason: "error" }, event: "end" });
    }
  }

  private broadcastState(): void {
    if (!this.ended) this.broadcast("state", this.stateEvent());
  }

  private allow(userId: string): boolean {
    const now = Date.now();
    const recent = (this.inputs.get(userId) ?? []).filter((at) => now - at < 1_000);
    const allowed = recent.length < BROWSER_LIVE_LIMITS.inputsPerSecond;
    if (allowed) recent.push(now);
    this.inputs.set(userId, recent);
    return allowed;
  }

  // The streamer --------------------------------------------------------------------------------------------------

  private async wantFrames(): Promise<void> {
    if (this.ended || this.unavailable || this.views.size === 0) return;
    try {
      const streamer = await this.start(true);
      if (!streamer.frames) {
        streamer.frames = true;
        await this.write(streamer, { on: true, t: "frames" });
      }
      this.retries = 0;
    } catch (error) {
      this.unreachable(error);
    }
  }

  /** The current streamer, or the one starting (a rotation's replacement included). */
  private start(frames: boolean): Promise<Streamer> {
    if (this.streamer && !this.streamer.closed && !this.streamer.retiring) return Promise.resolve(this.streamer);
    this.starting ??= (async () => {
      if (this.ended || this.unavailable) throw Object.assign(new Error("browser_live_closed"), { code: "browser_live_closed" });
      // The selected agent rides with the first command, so a new streamer streams its tab from the start.
      const reply = await this.registration.channel({ action: "start", stdin: streamerLine({ on: frames, t: "frames" }) +
        streamerLine({ [AGENT_FIELD]: this.agents.selected, t: WORKSPACE_AGENT_PROTOCOL.LIVE_SELECT_MESSAGE }) });
      if (reply.action !== "start") throw Object.assign(new Error("browser_live_invalid"), { code: "workspace_runtime_incompatible" });
      const streamer = new Streamer(reply.execSessionId, frames);
      this.streamer = streamer;
      if (this.ended) {
        await this.close(streamer);
        throw Object.assign(new Error("browser_live_closed"), { code: "browser_live_closed" });
      }
      void this.pump(streamer);
      return streamer;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Reads the streamer back to back while it prints; a short pause only when it printed nothing. */
  private async pump(streamer: Streamer): Promise<void> {
    let failures = 0;
    while (!streamer.closed) {
      let reply: WorkspaceBrowserLiveReply;
      try {
        reply = await this.registration.channel({ action: "poll", cursor: streamer.cursor, execSessionId: streamer.execSessionId });
      } catch (error) {
        if (streamer.closed) return;
        failures += 1;
        if (failures >= BROWSER_LIVE_RELAY_LIMITS.pollFailures || GUEST_GONE.has(failureCode(error)) || NO_CHANNEL.has(failureCode(error))) {
          await this.lost(streamer, error);
          return;
        }
        await delay(100 * failures);
        continue;
      }
      if (streamer.closed) return;
      failures = 0;
      if (reply.action !== "poll") {
        await this.lost(streamer, Object.assign(new Error("browser_live_invalid"), { code: "workspace_runtime_incompatible" }));
        return;
      }
      streamer.cursor = reply.nextCursor;
      for (const chunk of reply.chunks) this.read(streamer, chunk);
      if (reply.done) {
        await this.exited(streamer);
        return;
      }
      if ((streamer.chars >= BROWSER_LIVE_RELAY_LIMITS.rotateChars || Date.now() - streamer.startedAt >= BROWSER_LIVE_RELAY_LIMITS.rotateMs) &&
        streamer.waiters.size === 0 && !this.agents.anyStarting() && !this.starting) {
        await this.rotate(streamer);
        return;
      }
      if (reply.chunks.length === 0) await delay(BROWSER_LIVE_RELAY_LIMITS.idlePollMs);
    }
  }

  private read(streamer: Streamer, chunk: string): void {
    streamer.chars += chunk.length;
    let start = 0;
    for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", start)) {
      const line = streamer.buffer + chunk.slice(start, newline);
      streamer.buffer = "";
      start = newline + 1;
      const message = decodeBrowserLiveLine(line);
      if (message) this.message(streamer, message);
    }
    streamer.buffer += chunk.slice(start);
    // A line no message fits is dropped; the next one starts clean.
    if (streamer.buffer.length > MAX_LINE_CHARS) streamer.buffer = "";
  }

  private message(streamer: Streamer, message: GuestMessage): void {
    streamer.printed = true;
    if (message.t === "state") streamer.stated();
    // A streamer being replaced still answers its commands, but its reports may be older than the new one's.
    if (message.t !== "ack" && streamer !== this.streamer) return;
    switch (message.t) {
      case "state": {
        const browser = message.browser === "running" ? "running" : "absent";
        const agent = guestMessageAgent(message);
        const before = this.agents.selected;
        let changed = browser !== this.browser;
        this.browser = browser;
        // The guest may only hand control back to the agent; the user gets it from their own Take or the handoff.
        if (browser !== "running") {
          if (changed) this.agents.clearBrowsing();
        } else if (agent !== null) {
          changed = this.agents.applyAgentState(agent, message.controller, message.page) || changed;
        }
        if (this.agents.selected !== before) this.selectionMoved();
        else if (changed) this.broadcastState();
        return;
      }
      case WORKSPACE_AGENT_PROTOCOL.LIVE_AGENTS_MESSAGE: {
        const before = this.agents.selected;
        if (!this.agents.applyAgents(message[WORKSPACE_AGENT_PROTOCOL.LIVE_AGENTS_FIELD])) return;
        if (this.agents.selected !== before) this.selectionMoved();
        else this.broadcastState();
        return;
      }
      case "steps": {
        // Only the selected agent's: a report sent before the guest learned a new selection is dropped.
        const agent = guestMessageAgent(message);
        if (agent !== this.agents.selected) return;
        const parsed = browserLiveStepsEventSchema.safeParse({ agent, steps: message.steps });
        if (!parsed.success) return;
        this.steps = parsed.data.steps;
        this.broadcast("steps", parsed.data);
        return;
      }
      case "frame": {
        const agent = guestMessageAgent(message);
        if (agent !== this.agents.selected) return;
        const parsed = browserLiveFrameEventSchema.safeParse({ agent, data: message.data, height: message.height, mime: "image/jpeg",
          seq: message.seq, width: message.width });
        // A JPEG's base64 starts with its SOI marker.
        if (!parsed.success || !parsed.data.data.startsWith("/9j/")) return;
        this.frame = parsed.data;
        this.broadcast("frame", parsed.data);
        return;
      }
      case "ack":
        if (typeof message.id === "string") streamer.waiters.get(message.id)?.(message as Ack);
        return;
      default:
        return;
    }
  }

  private write(streamer: Streamer, message: Readonly<Record<string, unknown>>): Promise<void> {
    const data = streamerLine(message);
    const next = this.writes.then(() => streamer.closed
      ? Promise.reject(Object.assign(new Error("browser_live_closed"), { code: "browser_live_closed" }))
      : this.registration.channel({ action: "write", data, execSessionId: streamer.execSessionId }));
    this.writes = next.catch(() => undefined);
    return next.then(() => undefined);
  }

  private async command(message: Readonly<Record<string, unknown>>, timeoutMs: number = BROWSER_LIVE_RELAY_LIMITS.commandMs): Promise<Ack> {
    const streamer = await this.start(this.views.size > 0);
    // A streamer started a moment ago may not have reached the guest's host yet (an older guest refuses then).
    if (!streamer.reported) await Promise.race([streamer.firstState, delay(BROWSER_LIVE_RELAY_LIMITS.firstStateMs)]);
    const id = randomUUID();
    const answer = new Promise<Ack>((resolve) => {
      const timer = setTimeout(() => resolve({ code: "timeout", ok: false }), timeoutMs);
      timer.unref?.();
      streamer.waiters.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
    try {
      await this.write(streamer, { ...message, id });
    } catch {
      streamer.waiters.get(id)?.({ code: "write_failed", ok: false });
    }
    const ack = await answer;
    streamer.waiters.delete(id);
    if (this.views.size === 0) this.scheduleLinger();
    return ack;
  }

  private close(streamer: Streamer): Promise<void> {
    if (streamer.closing) return streamer.closing;
    streamer.closed = true;
    if (this.streamer === streamer) this.streamer = null;
    for (const resolve of streamer.waiters.values()) resolve({ code: "streamer_closed", ok: false });
    streamer.waiters.clear();
    streamer.closing = this.registration.channel({ action: "close", execSessionId: streamer.execSessionId })
      .then(() => undefined, () => undefined);
    return streamer.closing;
  }

  /**
   * A fresh streamer takes over before the old one closes, so input never meets a gap; control stays in the guest.
   * Meanwhile commands go to the replacement: `start` hands it out while the old one is retiring.
   */
  private async rotate(streamer: Streamer): Promise<void> {
    streamer.retiring = true;
    if (this.views.size > 0 && !this.ended) {
      try {
        await this.start(streamer.frames);
      } catch (error) {
        await this.close(streamer);
        this.unreachable(error);
        return;
      }
    }
    await this.close(streamer);
  }

  /** The streamer ended by itself: one that never printed runs on a guest image without the live view. */
  private async exited(streamer: Streamer): Promise<void> {
    const printed = streamer.printed;
    await this.close(streamer);
    if (!printed) {
      this.notAvailable();
      return;
    }
    if (this.views.size > 0 && !this.ended) await this.wantFrames();
  }

  private async lost(streamer: Streamer, error: unknown): Promise<void> {
    await this.close(streamer);
    this.unreachable(error);
  }

  /**
   * The guest could not be reached: views see the browser as absent. A guest not running yet (or stopped
   * meanwhile) is looked for again while a view is open, at no runtime cost; other failures a limited number of
   * times; a runtime without the channel ends the views.
   */
  private unreachable(error: unknown): void {
    const code = failureCode(error);
    if (this.ended || code === "browser_live_closed") return;
    if (NO_CHANNEL.has(code)) {
      this.notAvailable();
      return;
    }
    const guestGone = GUEST_GONE.has(code);
    if (!guestGone) {
      logEvent("runtime_lifecycle", { action: "retry", code: "workspace_browser_live_unavailable", outcome: "failed", stage: "dispatch",
        subsystem: "workspace" });
    }
    if (this.browser !== "absent") {
      this.browser = "absent";
      const before = this.agents.selected;
      this.agents.clearBrowsing();
      if (this.agents.selected !== before) this.selectionMoved();
      else this.broadcastState();
    }
    if (this.views.size === 0 || this.retry) return;
    if (!guestGone && ++this.retries > BROWSER_LIVE_RELAY_LIMITS.retries) {
      for (const { writer } of this.views.values()) writer.close({ data: { reason: "error" }, event: "end" });
      this.views.clear();
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.wantFrames();
    }, BROWSER_LIVE_RELAY_LIMITS.retryMs);
    this.retry.unref?.();
  }

  private notAvailable(): void {
    this.unavailable = true;
    for (const { writer } of this.views.values()) writer.close({ data: { reason: "not_available" }, event: "end" });
    this.views.clear();
  }

  private scheduleLinger(): void {
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.linger = null;
      const streamer = this.streamer;
      if (this.views.size === 0 && streamer && streamer.waiters.size === 0) void this.close(streamer);
    }, BROWSER_LIVE_RELAY_LIMITS.lingerMs);
    this.linger.unref?.();
  }

  private clearLinger(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
  }
}

export type BrowserLiveView = Pick<LiveRun, "answerHandoff" | "control" | "input" | "unwatch" | "watch">;

/** The process's live browsers by run and by chat (one active run per chat). */
export class BrowserLiveRelay {
  private readonly chats = new Map<string, LiveRun>();

  /** The engine: one interactive web run with a Workspace. A newer run of the chat ends an older one's views. */
  register(registration: BrowserLiveRegistration): BrowserLiveRunHandle {
    const previous = this.chats.get(registration.chatId);
    if (previous && previous.registration.runId !== registration.runId) void previous.end("run_finished");
    const run: LiveRun = new LiveRun(registration, () => {
      if (this.chats.get(registration.chatId) === run) this.chats.delete(registration.chatId);
    });
    this.chats.set(registration.chatId, run);
    return run;
  }

  /** The chat's live browser, only for the run's owner; anyone else, administrators included, finds nothing. */
  find(chatId: string, userId: string): BrowserLiveView | null {
    const run = this.chats.get(chatId);
    return run && !run.ended && run.registration.userId === userId ? run : null;
  }
}

const RELAY = Symbol.for("aiqsa.workspace.browserLive.v1");

/** Shared by every server bundle of the process, like the run controllers (`activeRunControllerRegistry.ts`). */
export function browserLiveRelay(): BrowserLiveRelay {
  const shared = globalThis as typeof globalThis & { [RELAY]?: BrowserLiveRelay };
  return shared[RELAY] ??= new BrowserLiveRelay();
}
