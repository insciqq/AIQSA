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

/** A client point on the displayed frame, scaled to frame pixels; null outside the frame or before it has a size. */
export function framePointV2(clientX: number, clientY: number, rect: Rect, frame: FrameSize): FramePoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return null;
  return {
    x: Math.round(clamp(relativeX * frame.width, 0, frame.width - 1) * 10) / 10,
    y: Math.round(clamp(relativeY * frame.height, 0, frame.height - 1) * 10) / 10
  };
}

/** A distance on screen in frame pixels (two-finger scrolling follows the fingers). */
export function frameDeltaV2(delta: number, displayed: number, frame: number): number {
  return displayed > 0 ? delta * frame / displayed : delta;
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
 * key down. Null for modifiers alone, IME composition and paste (the paste
 * event sends the clipboard text instead).
 */
export function keyDownInputV2(event: KeyboardLike): BrowserLiveInput | null {
  if (event.isComposing || event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(event.key) || event.key.length > BROWSER_LIVE_LIMITS.keyChars) return null;
  const shortcut = (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.altKey);
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
  toFrame(clientX: number, clientY: number): FramePoint | null;
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

const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const PINCH_THRESHOLD = 0.08;
const NONE: GestureOutput = { inputs: [] };

/**
 * Pointer gestures on the frame. A mouse or pen acts at once. One finger taps
 * (mouse down and up) or drags (down, moves, up) once it leaves the tap slop;
 * two fingers pinch to zoom the frame, or scroll: the page by wheel input when
 * the frame fits, the zoomed frame itself otherwise.
 */
export class BrowserLivePointerGesture {
  private readonly pointers = new Map<number, TrackedPointer>();
  /** The one-finger touch has become a drag (its mouse down was sent). */
  private dragging = false;
  /** A two-finger gesture ran; remaining fingers are ignored until all lift. */
  private consumed = false;
  private twoFinger: { mode: "undecided" | "pinch" | "scroll"; startDistance: number; distance: number; cx: number; cy: number } | null = null;
  private pressed: "left" | "middle" | "right" | null = null;
  private lastClick: { at: number; x: number; y: number; button: string; count: number } | null = null;

  /** Forgets every pointer, for example after control changed hands. */
  reset(): void {
    this.pointers.clear();
    this.dragging = false;
    this.consumed = false;
    this.twoFinger = null;
    this.pressed = null;
  }

  private clickCount(point: FramePoint, button: string, now: number): number {
    const last = this.lastClick;
    const count = last && last.button === button && now - last.at <= MULTI_CLICK_MS &&
      Math.hypot(point.x - last.x, point.y - last.y) <= TAP_SLOP_PX ? Math.min(3, last.count + 1) : 1;
    this.lastClick = { at: now, x: point.x, y: point.y, button, count };
    return count;
  }

  private mouse(type: "down" | "move" | "up", point: FramePoint, event: PointerLike, button: "none" | "left" | "middle" | "right", clickCount?: number): BrowserLiveInput {
    const modifiers = modifiersV2(event);
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
      // A drag in progress ends where the first finger is now.
      if (this.dragging && env.userControls) {
        const point = env.toFrame(first.x, first.y);
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
    if (event.pointerType !== "touch") {
      if (!env.userControls) return NONE;
      const point = env.toFrame(event.clientX, event.clientY);
      return point ? { inputs: [this.mouse("move", point, event, this.pressed ?? "none")] } : NONE;
    }
    if (!pointer) return NONE;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (this.twoFinger) return this.moveTwoFingers(env);
    if (this.consumed || !env.userControls) return NONE;
    if (!this.dragging) {
      if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) <= TAP_SLOP_PX) return NONE;
      const start = env.toFrame(pointer.startX, pointer.startY);
      if (!start) return NONE;
      this.dragging = true;
      const inputs: BrowserLiveInput[] = [this.mouse("down", start, event, "left", 1)];
      const point = env.toFrame(pointer.x, pointer.y);
      if (point) inputs.push(this.mouse("move", point, event, "left"));
      return { inputs };
    }
    const point = env.toFrame(pointer.x, pointer.y);
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
      const point = env.toFrame(event.clientX, event.clientY) ?? (pointer ? env.toFrame(pointer.x, pointer.y) : null);
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
    const point = env.toFrame(pointer.x, pointer.y);
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
  now?(): number;
}>;

/** Requests one owner sends per second at most; a margin under the server's limit. */
export const BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND = BROWSER_LIVE_LIMITS.inputsPerSecond - 10;
/** Pending inputs kept at most; moves go first when it overflows. */
export const BROWSER_LIVE_QUEUE_MAX = 64;
const RATE_LIMIT_PAUSE_MS = 1_000;

function isMove(input: BrowserLiveInput): boolean {
  return input.kind === "mouse" && input.type === "move";
}

function isWheel(input: BrowserLiveInput): input is Extract<BrowserLiveInput, { kind: "mouse" }> {
  return input.kind === "mouse" && input.type === "wheel";
}

/**
 * Sends inputs one at a time in order, so a click's down never overtakes its
 * up. Moves and wheel waiting behind a request coalesce into the latest move
 * and one summed wheel; the rate stays under the server's limit.
 */
export class BrowserLiveInputQueue {
  private readonly queue: BrowserLiveInput[] = [];
  private readonly sentAt: number[] = [];
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get pending(): number {
    return this.queue.length;
  }

  push(...inputs: BrowserLiveInput[]): void {
    if (this.closed) return;
    for (const input of inputs) this.enqueue(input);
    this.pump();
  }

  /** Drops everything waiting, for example when the agent takes control back. */
  clear(): void {
    this.queue.length = 0;
  }

  close(): void {
    this.closed = true;
    this.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueue(input: BrowserLiveInput): void {
    const last = this.queue.at(-1);
    if (last && isMove(input) && isMove(last)) {
      this.queue[this.queue.length - 1] = input;
      return;
    }
    if (last && isWheel(input) && isWheel(last) && last.modifiers === input.modifiers) {
      this.queue[this.queue.length - 1] = { ...input,
        deltaX: wheelDelta((last.deltaX ?? 0) + (input.deltaX ?? 0)),
        deltaY: wheelDelta((last.deltaY ?? 0) + (input.deltaY ?? 0)) };
      return;
    }
    this.queue.push(input);
    while (this.queue.length > BROWSER_LIVE_QUEUE_MAX) {
      const move = this.queue.findIndex(isMove);
      // Without a move to drop, the newest input is the one that does not fit.
      this.queue.splice(move >= 0 ? move : this.queue.length - 1, 1);
      if (move < 0) {
        this.options.onRefused("browser_live_rate_limited");
        break;
      }
    }
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delay));
  }

  private pump(): void {
    if (this.closed || this.inFlight || this.queue.length === 0) return;
    const now = this.now();
    if (now < this.pausedUntil) return this.schedule(this.pausedUntil - now);
    while (this.sentAt.length > 0 && now - this.sentAt[0]! >= 1_000) this.sentAt.shift();
    if (this.sentAt.length >= BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND) return this.schedule(this.sentAt[0]! + 1_000 - now);
    const input = this.queue.shift()!;
    this.sentAt.push(now);
    this.inFlight = true;
    void this.options.send(input).then((result) => {
      this.inFlight = false;
      if (this.closed) return;
      if (!result.ok) {
        if (result.code === "browser_live_rate_limited") {
          // The server refused this one; the rest waits a moment.
          this.pausedUntil = this.now() + RATE_LIMIT_PAUSE_MS;
        } else {
          this.clear();
        }
        this.options.onRefused(result.code);
      }
      this.pump();
    });
  }
}
