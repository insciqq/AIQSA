import { BROWSER_LIVE_LIMITS, type BrowserLiveInput } from "@/lib/contracts/browserLive";
import type { BrowserLiveRequestResult } from "./browserLiveClient";
import type { BrowserLiveFailureCodeV2 } from "./browserLivePresentation";

/**
 * Input of the live browser view: pointer, wheel, touch and keyboard events
 * mapped to `BrowserLiveInput` in frame pixels, and a queue that keeps them in
 * order, coalesces moves and wheel, and stays under the server's rate limit.
 * Typed text exists only in the request bodies; nothing is logged or stored.
 */

export type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;
export type FrameSize = Readonly<{ width: number; height: number }>;
export type FramePoint = Readonly<{ x: number; y: number }>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A client point on the displayed frame, scaled to frame pixels. Null before
 * the frame has a size, and outside it unless `clampToEdge` puts the point on
 * the nearest edge (a held button or a drag that left the frame).
 */
export function framePointV2(clientX: number, clientY: number, rect: Rect, frame: FrameSize, clampToEdge = false): FramePoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  if (!clampToEdge && (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1)) return null;
  return {
    x: Math.round(clamp(relativeX * frame.width, 0, frame.width - 1) * 10) / 10,
    y: Math.round(clamp(relativeY * frame.height, 0, frame.height - 1) * 10) / 10
  };
}

type ModifierKeys = Readonly<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>;

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersV2(event: ModifierKeys): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export function mouseButtonV2(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

function wheelDelta(value: number): number {
  // `|| 0` keeps a still axis at 0 rather than -0.
  return clamp(Math.round(value), -10_000, 10_000) || 0;
}

/** Wheel deltas in pixels: lines are 16 px, pages the frame's height. */
export function wheelPixelsV2(delta: number, deltaMode: number, frameHeight: number): number {
  return wheelDelta(deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * frameHeight : delta);
}

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Fn", "Meta", "NumLock", "OS", "Shift", "Super"]);

type KeyboardLike = ModifierKeys & Readonly<{ key: string; code: string; isComposing?: boolean }>;

/**
 * One key press as page input: printable characters as `text` (layouts and
 * AltGr already applied), everything else, and shortcuts with Ctrl or Meta, as
 * key down. Space is a key press too, which the guest types as a space: pages
 * act on its keydown (a focused checkbox, button or player). Null for
 * modifiers alone, IME composition and paste (the paste event sends the
 * clipboard text instead).
 */
export function keyDownInputV2(event: KeyboardLike): BrowserLiveInput | null {
  if (event.isComposing || event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(event.key) || event.key.length > BROWSER_LIVE_LIMITS.keyChars) return null;
  const shortcut = (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.altKey);
  if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return { kind: "key", type: "down", key: " ", code: "Space", ...(event.shiftKey ? { modifiers: modifiersV2(event) } : {}) };
  }
  if ([...event.key].length === 1 && !shortcut) return { kind: "text", text: event.key };
  if (shortcut && event.key.toLowerCase() === "v") return null;
  return { kind: "key", type: "down", key: event.key, code: event.code.slice(0, BROWSER_LIVE_LIMITS.keyChars),
    ...(modifiersV2(event) ? { modifiers: modifiersV2(event) } : {}) };
}

/** The key up matching a key down this view sent; printable text has none. */
export function keyUpInputV2(event: KeyboardLike): BrowserLiveInput {
  return { kind: "key", type: "up", key: event.key, code: event.code.slice(0, BROWSER_LIVE_LIMITS.keyChars),
    ...(modifiersV2(event) ? { modifiers: modifiersV2(event) } : {}) };
}

/** A named key pressed and released: the phone field's Enter, Backspace and Tab. */
export function keyPressInputsV2(key: "Backspace" | "Enter" | "Tab", modifiers = 0): BrowserLiveInput[] {
  return (["down", "up"] as const).map((type) => ({ kind: "key" as const, type, key, code: key,
    ...(modifiers ? { modifiers } : {}) }));
}

// Control characters the contract refuses; line breaks become Enter presses instead.
const UNSENDABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Pasted or typed text as page input: chunks within the limit, line breaks as Enter. */
export function textInputsV2(text: string): BrowserLiveInput[] {
  const inputs: BrowserLiveInput[] = [];
  const lines = text.replace(UNSENDABLE, "").replace(/\r\n?/gu, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) inputs.push(...keyPressInputsV2("Enter"));
    const characters = [...line];
    for (let start = 0; start < characters.length; start += BROWSER_LIVE_LIMITS.textChars / 2) {
      const chunk = characters.slice(start, start + BROWSER_LIVE_LIMITS.textChars / 2).join("");
      if (chunk) inputs.push({ kind: "text", text: chunk });
    }
  }
  return inputs;
}

type PointerLike = Readonly<{
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}>;

export type GestureEnvironment = Readonly<{
  /** The user controls the browser: pointer input goes to the page. */
  userControls: boolean;
  /** The frame is zoomed in, so two fingers pan the view instead of scrolling the page. */
  zoomed: boolean;
  /** A client point in frame pixels; with `clampToEdge`, a point outside lands on the frame's edge instead of null. */
  toFrame(clientX: number, clientY: number, clampToEdge?: boolean): FramePoint | null;
  /** Frame pixels per displayed pixel. */
  scale: number;
  now: number;
}>;

export type GestureOutput = Readonly<{
  inputs: BrowserLiveInput[];
  zoomBy?: Readonly<{ factor: number; clientX: number; clientY: number }>;
  panBy?: Readonly<{ dx: number; dy: number }>;
}>;

type TrackedPointer = { type: string; startX: number; startY: number; x: number; y: number; button: number };
type MouseButton = "left" | "middle" | "right";

const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const PINCH_THRESHOLD = 0.08;
const NONE: GestureOutput = { inputs: [] };

/**
 * Pointer gestures on the frame. A mouse or pen acts at once. One finger taps
 * (mouse down and up) or drags (down, moves, up) once it leaves the tap slop;
 * two fingers pinch to zoom the frame, or scroll: the page by wheel input when
 * the frame fits, the zoomed frame itself otherwise. While a button is held or
 * a drag runs, a pointer outside the frame acts on its edge, so the release
 * always reaches the page.
 */
export class BrowserLivePointerGesture {
  private readonly pointers = new Map<number, TrackedPointer>();
  /** The one-finger touch has become a drag (its mouse down was sent). */
  private dragging = false;
  /** A two-finger gesture ran; remaining fingers are ignored until all lift. */
  private consumed = false;
  private twoFinger: { mode: "undecided" | "pinch" | "scroll"; startDistance: number; distance: number; cx: number; cy: number } | null = null;
  private pressed: MouseButton | null = null;
  /** Where the last mouse input this gesture sent happened, for a release without a pointer event. */
  private lastPoint: FramePoint | null = null;
  private lastClick: { at: number; x: number; y: number; button: string; count: number } | null = null;

  /** Forgets every pointer, for example after control changed hands. Call `release` first to free a held button. */
  reset(): void {
    this.pointers.clear();
    this.dragging = false;
    this.consumed = false;
    this.twoFinger = null;
    this.pressed = null;
  }

  /** The mouse up that frees a held button or an unfinished drag (focus left, control ended); then forgets the gesture. */
  release(): BrowserLiveInput[] {
    const button = this.pressed ?? (this.dragging ? "left" : null);
    const point = this.lastPoint;
    this.reset();
    return button && point ? [{ kind: "mouse", type: "up", x: point.x, y: point.y, button, clickCount: 1 }] : [];
  }

  private clickCount(point: FramePoint, button: string, now: number): number {
    const last = this.lastClick;
    const count = last && last.button === button && now - last.at <= MULTI_CLICK_MS &&
      Math.hypot(point.x - last.x, point.y - last.y) <= TAP_SLOP_PX ? Math.min(3, last.count + 1) : 1;
    this.lastClick = { at: now, x: point.x, y: point.y, button, count };
    return count;
  }

  private mouse(type: "down" | "move" | "up", point: FramePoint, event: PointerLike, button: "none" | MouseButton, clickCount?: number): BrowserLiveInput {
    const modifiers = modifiersV2(event);
    this.lastPoint = point;
    return { kind: "mouse", type, x: point.x, y: point.y, button,
      ...(clickCount !== undefined ? { clickCount } : {}), ...(modifiers ? { modifiers } : {}) };
  }

  down(event: PointerLike, env: GestureEnvironment): GestureOutput {
    this.pointers.set(event.pointerId, { type: event.pointerType, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, button: event.button });
    if (event.pointerType !== "touch") {
      const point = env.toFrame(event.clientX, event.clientY);
      if (!env.userControls || !point) return NONE;
      const button = mouseButtonV2(event.button);
      this.pressed = button;
      return { inputs: [this.mouse("down", point, event, button, this.clickCount(point, button, env.now))] };
    }
    const touches = [...this.pointers.values()].filter((pointer) => pointer.type === "touch");
    if (touches.length === 2 && !this.consumed) {
      const [first, second] = touches as [TrackedPointer, TrackedPointer];
      const inputs: BrowserLiveInput[] = [];
      // A drag in progress ends where the first finger is now, on the frame's edge if it left the frame.
      if (this.dragging && env.userControls) {
        const point = env.toFrame(first.x, first.y, true);
        if (point) inputs.push(this.mouse("up", point, event, "left", 1));
      }
      this.dragging = false;
      this.consumed = true;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      this.twoFinger = { mode: "undecided", startDistance: distance, distance, cx: (first.x + second.x) / 2, cy: (first.y + second.y) / 2 };
      return { inputs };
    }
    return NONE;
  }

  move(event: PointerLike, env: GestureEnvironment): GestureOutput {
    const pointer = this.pointers.get(event.pointerId);
    if (pointer) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }
    if (event.pointerType !== "touch") {
      if (!env.userControls) return NONE;
      const point = env.toFrame(event.clientX, event.clientY, this.pressed !== null);
      return point ? { inputs: [this.mouse("move", point, event, this.pressed ?? "none")] } : NONE;
    }
    if (!pointer) return NONE;
    if (this.twoFinger) return this.moveTwoFingers(env);
    if (this.consumed || !env.userControls) return NONE;
    if (!this.dragging) {
      if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) <= TAP_SLOP_PX) return NONE;
      const start = env.toFrame(pointer.startX, pointer.startY, true);
      if (!start) return NONE;
      this.dragging = true;
      const inputs: BrowserLiveInput[] = [this.mouse("down", start, event, "left", 1)];
      const point = env.toFrame(pointer.x, pointer.y, true);
      if (point) inputs.push(this.mouse("move", point, event, "left"));
      return { inputs };
    }
    const point = env.toFrame(pointer.x, pointer.y, true);
    return point ? { inputs: [this.mouse("move", point, event, "left")] } : NONE;
  }

  private moveTwoFingers(env: GestureEnvironment): GestureOutput {
    const gesture = this.twoFinger!;
    const touches = [...this.pointers.values()].filter((pointer) => pointer.type === "touch");
    if (touches.length < 2) return NONE;
    const [first, second] = touches as [TrackedPointer, TrackedPointer];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const cx = (first.x + second.x) / 2;
    const cy = (first.y + second.y) / 2;
    if (gesture.mode === "undecided" && gesture.startDistance > 0 &&
      Math.abs(distance / gesture.startDistance - 1) > PINCH_THRESHOLD) gesture.mode = "pinch";
    else if (gesture.mode === "undecided" && Math.hypot(cx - gesture.cx, cy - gesture.cy) > TAP_SLOP_PX) gesture.mode = "scroll";
    if (gesture.mode === "undecided") return NONE;
    const dx = cx - gesture.cx;
    const dy = cy - gesture.cy;
    const factor = gesture.distance > 0 ? distance / gesture.distance : 1;
    gesture.distance = distance;
    gesture.cx = cx;
    gesture.cy = cy;
    if (gesture.mode === "pinch") return { inputs: [], zoomBy: { factor, clientX: cx, clientY: cy } };
    if (env.zoomed) return { inputs: [], panBy: { dx: -dx || 0, dy: -dy || 0 } };
    if (!env.userControls) return NONE;
    const point = env.toFrame(cx, cy);
    if (!point) return NONE;
    return { inputs: [{ kind: "mouse", type: "wheel", x: point.x, y: point.y,
      deltaX: wheelDelta(-dx * env.scale), deltaY: wheelDelta(-dy * env.scale) }] };
  }

  up(event: PointerLike, env: GestureEnvironment, cancelled = false): GestureOutput {
    const pointer = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    if (event.pointerType !== "touch") {
      const button = this.pressed;
      this.pressed = null;
      if (!env.userControls || !button) return NONE;
      // A release outside the frame (the pointer is captured) lands on its edge.
      const point = env.toFrame(event.clientX, event.clientY, true);
      return point ? { inputs: [this.mouse("up", point, event, button, this.lastClick?.count ?? 1)] } : NONE;
    }
    if (!pointer) return NONE;
    const remaining = [...this.pointers.values()].some((tracked) => tracked.type === "touch");
    if (this.consumed) {
      if (!remaining) this.reset();
      else this.twoFinger = null;
      return NONE;
    }
    const wasDragging = this.dragging;
    this.dragging = false;
    if (!env.userControls) return NONE;
    const point = env.toFrame(pointer.x, pointer.y, true);
    if (!point) return NONE;
    if (wasDragging) return { inputs: [this.mouse("up", point, event, "left", 1)] };
    // A cancelled touch that never moved was the browser's own gesture, not a tap.
    if (cancelled) return NONE;
    const count = this.clickCount(point, "left", env.now);
    return { inputs: [this.mouse("down", point, event, "left", count), this.mouse("up", point, event, "left", count)] };
  }
}

type QueueOptions = Readonly<{
  send(input: BrowserLiveInput): Promise<BrowserLiveRequestResult>;
  /** A refusal the panel shows; the queue has already dropped what it no longer may send. */
  onRefused(code: BrowserLiveFailureCodeV2): void;
  /** The server accepted an input. */
  onAccepted?(): void;
  /** Releases still queued when the queue closed; the owner sends them best effort. */
  onClosedWithReleases?(releases: BrowserLiveInput[]): void;
  now?(): number;
}>;

/** Requests one owner sends per second at most; a margin under the server's limit. */
export const BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND = BROWSER_LIVE_LIMITS.inputsPerSecond - 10;
/** Moves without a pressed button (hover) sent per second at most; each one is a page dispatch in the guest. */
export const BROWSER_LIVE_HOVER_MOVES_PER_SECOND = 15;
/** Pending inputs kept at most; moves go first when it overflows. */
export const BROWSER_LIVE_QUEUE_MAX = 64;
const RATE_LIMIT_PAUSE_MS = 1_000;
const HOVER_INTERVAL_MS = Math.ceil(1_000 / BROWSER_LIVE_HOVER_MOVES_PER_SECOND);

function isMove(input: BrowserLiveInput): boolean {
  return input.kind === "mouse" && input.type === "move";
}

function isHover(input: BrowserLiveInput): boolean {
  return input.kind === "mouse" && input.type === "move" && (input.button ?? "none") === "none";
}

function isWheel(input: BrowserLiveInput): input is Extract<BrowserLiveInput, { kind: "mouse" }> {
  return input.kind === "mouse" && input.type === "wheel";
}

/** A press or a release, by the key or button it holds; null for anything else. */
function holdOf(input: BrowserLiveInput): Readonly<{ id: string; press: boolean }> | null {
  if (input.kind === "key") return { id: `key:${input.code || input.key}`, press: input.type === "down" };
  if (input.kind === "mouse" && (input.type === "down" || input.type === "up")) {
    return { id: `mouse:${input.button ?? "left"}`, press: input.type === "down" };
  }
  return null;
}

function isRelease(input: BrowserLiveInput): boolean {
  return holdOf(input)?.press === false;
}

/**
 * Appends one input to a pending list, coalescing it into a trailing move or wheel. Typed text is never merged:
 * one insertion per character keeps code fields that move focus after each digit working.
 */
function coalesce(queue: BrowserLiveInput[], input: BrowserLiveInput): void {
  const last = queue.at(-1);
  if (last && isMove(input) && isMove(last)) {
    queue[queue.length - 1] = input;
    return;
  }
  if (last && isWheel(input) && isWheel(last) && last.modifiers === input.modifiers) {
    queue[queue.length - 1] = { ...input,
      deltaX: wheelDelta((last.deltaX ?? 0) + (input.deltaX ?? 0)),
      deltaY: wheelDelta((last.deltaY ?? 0) + (input.deltaY ?? 0)) };
    return;
  }
  queue.push(input);
}

/**
 * Sends inputs one at a time in order, so a click's down never overtakes its
 * up. Moves and wheel waiting behind a request coalesce into the latest move
 * and one summed wheel; hover moves are paced, and the rate stays under the
 * server's limit. One `push` is admitted whole or not at all, and a release
 * whose press was admitted is never dropped, so no key or button stays held.
 */
export class BrowserLiveInputQueue {
  private queue: BrowserLiveInput[] = [];
  private readonly sentAt: number[] = [];
  /** Keys and buttons pressed by admitted input and not yet released. */
  private readonly held = new Set<string>();
  /** Drains waiting for the queue, each told whether everything was delivered. */
  private readonly idleWaiters = new Set<(drained: boolean) => void>();
  /** The latest deadline of a pending drain; a close during a drain waits at most until then. */
  private drainDeadline = 0;
  /** `close()` was asked during a drain: no new input, but what is admitted keeps going out. */
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  private lastHoverAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Nothing waits and nothing is in flight. */
  get idle(): boolean {
    return this.queue.length === 0 && !this.inFlight;
  }

  push(...inputs: BrowserLiveInput[]): void {
    if (this.closed || this.closing || inputs.length === 0) return;
    const draft = [...this.queue];
    for (const input of inputs) coalesce(draft, input);
    // Waiting moves are only positions: they go first when the batch does not fit.
    for (let index = 0; draft.length > BROWSER_LIVE_QUEUE_MAX && index < draft.length;) {
      if (isMove(draft[index]!)) draft.splice(index, 1);
      else index += 1;
    }
    if (draft.length > BROWSER_LIVE_QUEUE_MAX) {
      // The batch is refused whole, except releases of presses admitted before it.
      const releases = inputs.filter((input) => {
        const hold = holdOf(input);
        return hold && !hold.press && this.held.has(hold.id);
      });
      for (const release of releases) {
        this.queue.push(release);
        this.held.delete(holdOf(release)!.id);
      }
      this.options.onRefused("browser_live_rate_limited");
      this.pump();
      return;
    }
    this.queue = draft;
    for (const input of inputs) {
      const hold = holdOf(input);
      if (hold?.press) this.held.add(hold.id);
      else if (hold) this.held.delete(hold.id);
    }
    this.pump();
  }

  /** Drops everything waiting, for example when the agent takes control back. */
  clear(): void {
    this.queue = [];
    this.held.clear();
    this.notifyIdle();
  }

  /** Drops everything waiting except releases (key up, mouse up), which still go out: Cancel. */
  clearExceptReleases(): void {
    this.queue = this.queue.filter(isRelease);
    this.held.clear();
    this.notifyIdle();
  }

  /**
   * Resolves true once everything admitted was sent and answered, or false
   * after `timeoutMs` (the caller then clears what is left).
   */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.idle) return Promise.resolve(true);
    this.drainDeadline = Math.max(this.drainDeadline, this.now() + timeoutMs);
    return new Promise((resolve) => {
      const done = (drained: boolean) => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve(drained);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.idleWaiters.add(done);
    });
  }

  /**
   * Stops the queue. While an end of control drains, it keeps sending until
   * idle or the drain's deadline, so closing the panel never cuts the user's
   * last input short; otherwise it stops at once. Queued releases it drops go
   * to `onClosedWithReleases`.
   */
  close(): void {
    if (this.closed || this.closing) return;
    if (this.idleWaiters.size > 0 && !this.idle) {
      this.closing = true;
      this.closeTimer = setTimeout(() => this.finishClose(), Math.max(0, this.drainDeadline - this.now()));
      return;
    }
    this.finishClose();
  }

  private finishClose(): void {
    if (this.closed) return;
    const drained = this.idle;
    const releases = this.queue.filter(isRelease);
    this.closed = true;
    this.closing = false;
    this.queue = [];
    this.held.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.timer = null;
    this.closeTimer = null;
    for (const waiter of [...this.idleWaiters]) waiter(drained);
    if (releases.length > 0) this.options.onClosedWithReleases?.(releases);
  }

  private notifyIdle(): void {
    if (!this.idle) return;
    for (const waiter of [...this.idleWaiters]) waiter(true);
    if (this.closing) this.finishClose();
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delay));
  }

  private pump(): void {
    if (this.closed || this.inFlight) return;
    if (this.queue.length === 0) return this.notifyIdle();
    const now = this.now();
    if (now < this.pausedUntil) return this.schedule(this.pausedUntil - now);
    // A waiting hover is superseded only by later mouse input, which carries its own position; before a key or
    // text it still goes out, at most one pacing interval late.
    const tooSoon = now - this.lastHoverAt < HOVER_INTERVAL_MS;
    while (tooSoon && this.queue.length > 1 && isHover(this.queue[0]!) && this.queue[1]!.kind === "mouse") this.queue.shift();
    if (tooSoon && isHover(this.queue[0]!)) return this.schedule(this.lastHoverAt + HOVER_INTERVAL_MS - now);
    while (this.sentAt.length > 0 && now - this.sentAt[0]! >= 1_000) this.sentAt.shift();
    if (this.sentAt.length >= BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND) return this.schedule(this.sentAt[0]! + 1_000 - now);
    const input = this.queue.shift()!;
    this.sentAt.push(now);
    if (isHover(input)) this.lastHoverAt = now;
    this.inFlight = true;
    void this.options.send(input).then((result) => {
      this.inFlight = false;
      if (this.closed) return;
      if (!result.ok) {
        if (result.code === "browser_live_rate_limited") {
          // The server refused this one; the rest waits a moment.
          this.pausedUntil = this.now() + RATE_LIMIT_PAUSE_MS;
        } else {
          this.queue = [];
          this.held.clear();
        }
        this.options.onRefused(result.code);
      } else {
        this.options.onAccepted?.();
      }
      this.pump();
    });
  }
}
