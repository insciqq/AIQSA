import { randomBytes, randomUUID } from "node:crypto";
import {
  BROWSER_LIVE_LIMITS,
  BROWSER_LIVE_PROTOCOL_VERSION,
  browserLiveFrameEventSchema,
  browserLiveStateEventSchema,
  browserLiveStepsEventSchema,
  type BrowserHandoffOutcome,
  type BrowserHandoffReason,
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
 * history grows large. Control lives in the guest, so a rotation never changes it.
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
  /** Another handoff of the run is waiting. */
  | Readonly<{ kind: "busy" }>
  /** The live channel cannot reach this run's browser: a runtime or guest image without it, or a stopped guest. */
  | Readonly<{ kind: "unavailable" }>;

/** What the engine holds of its run. */
export type BrowserLiveRunHandle = Readonly<{
  end(reason?: Extract<BrowserLiveEndReason, "browser_stopped" | "run_finished">): Promise<void>;
  handoff(input: Readonly<{ message: string; reason: BrowserHandoffReason; signal: AbortSignal; waitMs: number }>): Promise<BrowserLiveHandoffResult>;
}>;

type GuestMessage = Readonly<Record<string, unknown>>;
type Ack = Readonly<{ ok?: unknown; code?: unknown; page?: unknown; saved?: unknown }>;
type PendingHandoff = {
  readonly expiresAt: number;
  readonly id: string;
  readonly message: string;
  readonly reason: BrowserHandoffReason;
  readonly resolve: (outcome: BrowserHandoffOutcome | "aborted") => void;
  readonly startedAt: number;
};

class Streamer {
  buffer = "";
  chars = 0;
  closed = false;
  closing: Promise<void> | null = null;
  cursor = 0;
  /** It printed a message: it runs on a guest that has the live view. */
  printed = false;
  readonly startedAt = Date.now();
  readonly waiters = new Map<string, (ack: Ack) => void>();

  constructor(readonly execSessionId: string, public frames: boolean) {}
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

function pageOf(value: unknown): BrowserLiveStateEvent["page"] {
  if (typeof value !== "object" || value === null) return null;
  const page = { title: (value as { title?: unknown }).title, url: (value as { url?: unknown }).url };
  const parsed = browserLiveStateEventSchema.shape.page.safeParse(page);
  return parsed.success ? parsed.data : null;
}

function samePage(left: BrowserLiveStateEvent["page"], right: BrowserLiveStateEvent["page"]): boolean {
  return left === right || (left !== null && right !== null && left.url === right.url && left.title === right.title);
}

function streamerLine(message: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(message) + "\n";
}

class LiveRun implements BrowserLiveRunHandle {
  browser: BrowserLiveStateEvent["browser"] = "absent";
  controller: BrowserLiveStateEvent["controller"] = "agent";
  ended = false;
  private ending: Promise<void> | null = null;
  private frame: BrowserLiveFrameEvent | null = null;
  private pending: PendingHandoff | null = null;
  private handoffStarting = false;
  private inputs = new Map<string, number[]>();
  private linger: ReturnType<typeof setTimeout> | null = null;
  private page: BrowserLiveStateEvent["page"] = null;
  private remembered: boolean | null = null;
  private retries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<Streamer> | null = null;
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
    const id = randomUUID();
    this.views.set(id, { viewer, writer });
    if (!writer.send("state", this.stateEvent()) || (this.steps && !writer.send("steps", { steps: this.steps }))) {
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

  /** One input from the owner, applied in arrival order, only while the user holds the browser. */
  async input(viewer: BrowserLiveViewer, input: BrowserLiveInput): Promise<BrowserLiveErrorCode | null> {
    if (this.ended) return "browser_live_not_found";
    if (!this.allow(viewer.userId)) return "browser_live_rate_limited";
    if (!this.userControls()) return "browser_live_not_in_control";
    const streamer = this.streamer;
    if (!streamer || streamer.closed) return "browser_live_unavailable";
    try {
      await this.write(streamer, { input, t: "input" });
    } catch {
      return "browser_live_unavailable";
    }
    return null;
  }

  /** Take control or Return control (watch mode); a pending handoff is answered with Done or Cancel instead. */
  async control(_viewer: BrowserLiveViewer, action: BrowserLiveControlRequest["action"]): Promise<BrowserLiveErrorCode | null> {
    if (this.ended) return "browser_live_not_found";
    if (this.pending) return action === "take" ? null : "browser_live_unavailable";
    if (this.browser !== "running") return "browser_live_unavailable";
    const ack = await this.command({ action, t: "control" }).catch(() => null);
    if (ack?.ok !== true) return "browser_live_unavailable";
    this.controller = action === "take" ? "user" : "agent";
    this.broadcastState();
    return null;
  }

  /** Done or Cancel on the pending handoff; another or an ended handoff is stale. */
  answerHandoff(_viewer: BrowserLiveViewer, request: BrowserLiveHandoffRequest): BrowserLiveErrorCode | null {
    if (this.ended) return "browser_live_not_found";
    const pending = this.pending;
    if (!pending || pending.id !== request.handoffId) return "browser_live_handoff_stale";
    pending.resolve(request.action === "done" ? "completed" : "cancelled");
    return null;
  }

  // The engine ----------------------------------------------------------------------------------------------------

  /**
   * The agent's handoff: the user holds the browser until Done, Cancel or `waitMs`; the run's Stop or deadline
   * (`signal`) ends it too, by throwing its reason. On Done the guest saves the current site's sign-in.
   */
  async handoff(input: Readonly<{ message: string; reason: BrowserHandoffReason; signal: AbortSignal; waitMs: number }>):
    Promise<BrowserLiveHandoffResult> {
    input.signal.throwIfAborted();
    if (this.ended || this.unavailable) return { kind: "unavailable" };
    if (this.pending || this.handoffStarting) return { kind: "busy" };
    this.handoffStarting = true;
    try {
      const begin = await this.command({ action: "begin", t: "handoff" });
      if (begin.ok !== true) {
        return begin.code === "browser_not_running" || begin.code === "no_page" ? { kind: "no_browser" } : { kind: "unavailable" };
      }
    } catch (error) {
      return GUEST_GONE.has(failureCode(error)) ? { kind: "no_browser" } : { kind: "unavailable" };
    } finally {
      this.handoffStarting = false;
    }
    const startedAt = Date.now();
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
      this.pending = { expiresAt: startedAt + input.waitMs, id: `handoff_${randomBytes(12).toString("base64url")}`,
        message: input.message, reason: input.reason, resolve: finish, startedAt };
      this.broadcastState();
      if (input.signal.aborted) finish("aborted");
    });
    this.pending = null;
    this.controller = "agent";
    this.broadcastState();
    if (outcome === "aborted") {
      // The run is ending: its guest stops with it, so the guest's control is ended without waiting.
      void this.command({ action: "end", outcome: "cancelled", t: "handoff" }, 2_000).catch(() => undefined);
      throw input.signal.reason ?? new Error("browser_handoff_aborted");
    }
    const end = await this.command({ action: "end", outcome, t: "handoff" }).catch(() => null);
    return { kind: "ended", outcome, page: end?.ok === true ? pageOf(end.page) : null,
      saved: end?.ok === true && typeof end.saved === "string" ? end.saved.slice(0, 200) : null };
  }

  /** The run's turn ended: views end with `reason` and the streamer goes, before the Workspace hands off or settles. */
  end(reason: Extract<BrowserLiveEndReason, "browser_stopped" | "run_finished"> = "run_finished"): Promise<void> {
    if (this.ending) return this.ending;
    this.ended = true;
    this.pending = null;
    this.browser = "stopped";
    this.controller = "agent";
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
    const pending = this.pending;
    const event: BrowserLiveStateEvent = {
      browser: this.browser,
      controller: pending ? "user" : this.controller,
      handoff: pending ? { expiresAt: new Date(pending.expiresAt).toISOString(), id: pending.id, message: pending.message,
        reason: pending.reason, startedAt: new Date(pending.startedAt).toISOString() } : null,
      page: this.page,
      runId: this.registration.runId,
      signInRemembered: this.remembered === true,
      version: BROWSER_LIVE_PROTOCOL_VERSION
    };
    return browserLiveStateEventSchema.safeParse(event).success ? event : { ...event, handoff: null, page: null };
  }

  private userControls(): boolean {
    return this.pending !== null || this.controller === "user";
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

  private start(frames: boolean, replacing?: Streamer): Promise<Streamer> {
    if (this.streamer && !this.streamer.closed && this.streamer !== replacing) return Promise.resolve(this.streamer);
    this.starting ??= (async () => {
      if (this.ended || this.unavailable) throw Object.assign(new Error("browser_live_closed"), { code: "browser_live_closed" });
      const reply = await this.registration.channel({ action: "start", stdin: streamerLine({ on: frames, t: "frames" }) });
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
        streamer.waiters.size === 0) {
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
    switch (message.t) {
      case "state": {
        const browser = message.browser === "running" ? "running" : "absent";
        const controller = message.controller === "user" ? "user" : "agent";
        const page = browser === "running" ? pageOf(message.page) : null;
        if (browser === this.browser && controller === this.controller && samePage(page, this.page)) return;
        this.browser = browser;
        this.controller = controller;
        this.page = page;
        this.broadcastState();
        return;
      }
      case "steps": {
        const parsed = browserLiveStepsEventSchema.safeParse({ steps: message.steps });
        if (!parsed.success) return;
        this.steps = parsed.data.steps;
        this.broadcast("steps", parsed.data);
        return;
      }
      case "frame": {
        const parsed = browserLiveFrameEventSchema.safeParse({ data: message.data, height: message.height, mime: "image/jpeg",
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

  /** A fresh streamer takes over before the old one closes, so input never meets a gap; control stays in the guest. */
  private async rotate(streamer: Streamer): Promise<void> {
    if (this.views.size > 0 && !this.ended) {
      try {
        await this.start(streamer.frames, streamer);
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
      this.controller = "agent";
      this.page = null;
      this.broadcastState();
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
