import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserLiveInput } from "@/lib/contracts/browserLive";
import { browserLiveInputSchema } from "@/lib/contracts/browserLive";
import {
  BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND,
  BrowserLiveInputQueue,
  BrowserLivePointerGesture,
  framePointV2,
  keyDownInputV2,
  textInputsV2,
  wheelPixelsV2,
  type GestureEnvironment
} from "./browserLiveInput";

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const rect = { left: 100, top: 50, width: 640, height: 400 };
const frame = { width: 1280, height: 800 };

function env(overrides: Partial<GestureEnvironment> = {}): GestureEnvironment {
  return { userControls: true, zoomed: false, scale: 2, now: 1_000,
    toFrame: (x, y) => framePointV2(x, y, rect, frame), ...overrides };
}

function pointer(pointerId: number, pointerType: string, clientX: number, clientY: number, button = 0) {
  return { ...keys, button, clientX, clientY, pointerId, pointerType };
}

describe("framePointV2", () => {
  it("scales the displayed point to frame pixels and refuses points outside the frame", () => {
    expect(framePointV2(420, 250, rect, frame)).toEqual({ x: 640, y: 400 });
    expect(framePointV2(100, 50, rect, frame)).toEqual({ x: 0, y: 0 });
    expect(framePointV2(740, 450, rect, frame)).toEqual({ x: 1279, y: 799 });
    expect(framePointV2(99, 60, rect, frame)).toBeNull();
    expect(framePointV2(120, 60, { ...rect, width: 0 }, frame)).toBeNull();
  });
});

describe("keyboard mapping", () => {
  it("sends printable characters as text and named keys and shortcuts as key down", () => {
    expect(keyDownInputV2({ ...keys, key: "ж", code: "Semicolon" })).toEqual({ kind: "text", text: "ж" });
    expect(keyDownInputV2({ ...keys, shiftKey: true, key: "A", code: "KeyA" })).toEqual({ kind: "text", text: "A" });
    expect(keyDownInputV2({ ...keys, key: "Enter", code: "Enter" })).toEqual({ kind: "key", type: "down", key: "Enter", code: "Enter" });
    expect(keyDownInputV2({ ...keys, ctrlKey: true, key: "a", code: "KeyA" }))
      .toEqual({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 2 });
    // AltGr arrives as Ctrl+Alt and types a character.
    expect(keyDownInputV2({ ...keys, ctrlKey: true, altKey: true, key: "@", code: "KeyQ" })).toEqual({ kind: "text", text: "@" });
  });

  it("ignores modifiers alone, IME composition and paste shortcuts", () => {
    expect(keyDownInputV2({ ...keys, shiftKey: true, key: "Shift", code: "ShiftLeft" })).toBeNull();
    expect(keyDownInputV2({ ...keys, key: "a", code: "KeyA", isComposing: true })).toBeNull();
    expect(keyDownInputV2({ ...keys, key: "Process", code: "KeyA" })).toBeNull();
    expect(keyDownInputV2({ ...keys, metaKey: true, key: "v", code: "KeyV" })).toBeNull();
  });

  it("turns pasted text into bounded text inputs with Enter for line breaks", () => {
    const long = "я".repeat(700);
    const inputs = textInputsV2(`user@example.test\r\n${long}\u0007`);
    expect(inputs.map((input) => input.kind === "key" ? `${input.type}:${input.key}` : input.kind === "text" ? input.text.length : null))
      .toEqual([17, "down:Enter", "up:Enter", 512, 188]);
    for (const input of inputs) expect(browserLiveInputSchema.safeParse(input).success).toBe(true);
  });

  it("converts wheel lines and pages to pixels", () => {
    expect(wheelPixelsV2(3, 1, 800)).toBe(48);
    expect(wheelPixelsV2(1, 2, 800)).toBe(800);
    expect(wheelPixelsV2(1e9, 0, 800)).toBe(10_000);
  });
});

describe("BrowserLivePointerGesture", () => {
  it("maps a mouse double click to frame pixels with click counts", () => {
    const gesture = new BrowserLivePointerGesture();
    const first = gesture.down(pointer(1, "mouse", 420, 250), env());
    const up = gesture.up(pointer(1, "mouse", 420, 250), env());
    const second = gesture.down(pointer(1, "mouse", 421, 250), env({ now: 1_200 }));
    expect(first.inputs).toEqual([{ kind: "mouse", type: "down", x: 640, y: 400, button: "left", clickCount: 1 }]);
    expect(up.inputs).toEqual([{ kind: "mouse", type: "up", x: 640, y: 400, button: "left", clickCount: 1 }]);
    expect(second.inputs[0]).toMatchObject({ type: "down", clickCount: 2, x: 642 });
    expect(gesture.move(pointer(1, "mouse", 430, 250), env()).inputs).toEqual([
      { kind: "mouse", type: "move", x: 660, y: 400, button: "left" }
    ]);
  });

  it("sends nothing while the agent controls the browser", () => {
    const gesture = new BrowserLivePointerGesture();
    const agent = env({ userControls: false });
    expect(gesture.down(pointer(1, "mouse", 420, 250), agent).inputs).toEqual([]);
    expect(gesture.up(pointer(1, "mouse", 420, 250), agent).inputs).toEqual([]);
    expect(gesture.down(pointer(2, "touch", 420, 250), agent).inputs).toEqual([]);
    expect(gesture.up(pointer(2, "touch", 420, 250), agent).inputs).toEqual([]);
  });

  it("turns a touch tap into mouse down and up, and a drag into down, moves and up", () => {
    const gesture = new BrowserLivePointerGesture();
    expect(gesture.down(pointer(1, "touch", 200, 100), env()).inputs).toEqual([]);
    expect(gesture.move(pointer(1, "touch", 203, 102), env()).inputs).toEqual([]);
    expect(gesture.up(pointer(1, "touch", 203, 102), env()).inputs.map((input) => input.kind === "mouse" && input.type))
      .toEqual(["down", "up"]);

    gesture.down(pointer(2, "touch", 200, 100), env({ now: 5_000 }));
    const start = gesture.move(pointer(2, "touch", 230, 100), env({ now: 5_000 }));
    expect(start.inputs).toEqual([
      { kind: "mouse", type: "down", x: 200, y: 100, button: "left", clickCount: 1 },
      { kind: "mouse", type: "move", x: 260, y: 100, button: "left" }
    ]);
    expect(gesture.up(pointer(2, "touch", 230, 100), env()).inputs).toEqual([
      { kind: "mouse", type: "up", x: 260, y: 100, button: "left", clickCount: 1 }
    ]);
    // A touch the browser cancelled before it moved is not a tap.
    gesture.down(pointer(3, "touch", 200, 100), env());
    expect(gesture.up(pointer(3, "touch", 200, 100), env(), true).inputs).toEqual([]);
  });

  it("scrolls the page with two fingers, pans a zoomed frame and pinches to zoom", () => {
    const scroll = new BrowserLivePointerGesture();
    scroll.down(pointer(1, "touch", 200, 300), env());
    scroll.down(pointer(2, "touch", 300, 300), env());
    // Scrolled content follows the fingers: 15 displayed pixels up are 30 frame pixels down.
    expect(scroll.move(pointer(1, "touch", 200, 270), env()).inputs)
      .toEqual([{ kind: "mouse", type: "wheel", x: 300, y: 470, deltaX: 0, deltaY: 30 }]);
    expect(scroll.move(pointer(2, "touch", 300, 270), env()).inputs)
      .toEqual([{ kind: "mouse", type: "wheel", x: 300, y: 440, deltaX: 0, deltaY: 30 }]);
    // Lifting the fingers sends nothing more.
    expect(scroll.up(pointer(1, "touch", 200, 270), env()).inputs).toEqual([]);
    expect(scroll.up(pointer(2, "touch", 300, 270), env()).inputs).toEqual([]);

    const pan = new BrowserLivePointerGesture();
    pan.down(pointer(1, "touch", 200, 300), env({ zoomed: true }));
    pan.down(pointer(2, "touch", 300, 300), env({ zoomed: true }));
    pan.move(pointer(1, "touch", 200, 320), env({ zoomed: true }));
    expect(pan.move(pointer(2, "touch", 300, 320), env({ zoomed: true }))).toEqual({ inputs: [], panBy: { dx: 0, dy: -10 } });

    const pinch = new BrowserLivePointerGesture();
    pinch.down(pointer(1, "touch", 200, 300), env({ userControls: false }));
    pinch.down(pointer(2, "touch", 300, 300), env({ userControls: false }));
    const zoom = pinch.move(pointer(2, "touch", 400, 300), env({ userControls: false }));
    expect(zoom.zoomBy).toEqual({ factor: 2, clientX: 300, clientY: 300 });
  });

  it("ends a one-finger drag when a second finger arrives", () => {
    const gesture = new BrowserLivePointerGesture();
    gesture.down(pointer(1, "touch", 200, 100), env());
    gesture.move(pointer(1, "touch", 240, 100), env());
    expect(gesture.down(pointer(2, "touch", 300, 100), env()).inputs).toEqual([
      { kind: "mouse", type: "up", x: 280, y: 100, button: "left", clickCount: 1 }
    ]);
  });
});

describe("BrowserLiveInputQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(results: Array<{ ok: true } | { ok: false; code: "browser_live_not_in_control" | "browser_live_rate_limited" }> = []) {
    const sent: BrowserLiveInput[] = [];
    const resolvers: Array<() => void> = [];
    const refused = vi.fn();
    const queue = new BrowserLiveInputQueue({
      now: () => Date.now(),
      onRefused: refused,
      send: (input) => {
        sent.push(input);
        return new Promise((resolve) => resolvers.push(() => resolve(results.shift() ?? { ok: true })));
      }
    });
    const settle = async () => {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { queue, refused, sent, settle };
  }

  const move = (x: number): BrowserLiveInput => ({ kind: "mouse", type: "move", x, y: 1, button: "none" });
  const wheel = (deltaY: number): BrowserLiveInput => ({ kind: "mouse", type: "wheel", x: 1, y: 1, deltaX: 0, deltaY });

  it("sends one at a time in order, keeping only the latest move and one summed wheel", async () => {
    const { queue, sent, settle } = setup();
    queue.push({ kind: "mouse", type: "down", x: 1, y: 1, button: "left", clickCount: 1 });
    queue.push(move(2), move(3), move(4));
    queue.push(wheel(10), wheel(15));
    queue.push({ kind: "mouse", type: "up", x: 1, y: 1, button: "left", clickCount: 1 });
    expect(sent).toHaveLength(1);
    for (let index = 0; index < 4; index += 1) await settle();
    expect(sent.map((input) => input.kind === "mouse" ? `${input.type}:${input.type === "move" ? input.x : input.deltaY ?? ""}` : "")).toEqual([
      "down:", "move:4", "wheel:25", "up:"
    ]);
  });

  it("stays under the per-second limit", async () => {
    const { queue, sent, settle } = setup();
    for (let index = 0; index < 60; index += 1) queue.push({ kind: "text", text: String(index % 10) });
    for (let index = 0; index < 60; index += 1) await settle();
    expect(sent).toHaveLength(BROWSER_LIVE_CLIENT_INPUTS_PER_SECOND);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 0; index < 20; index += 1) await settle();
    expect(sent).toHaveLength(60);
  });

  it("drops what waits when the user no longer controls the browser, and pauses after a rate limit", async () => {
    const lost = setup([{ ok: false, code: "browser_live_not_in_control" }]);
    lost.queue.push({ kind: "text", text: "a" }, { kind: "text", text: "b" });
    await lost.settle();
    expect(lost.refused).toHaveBeenCalledWith("browser_live_not_in_control");
    expect(lost.queue.pending).toBe(0);
    expect(lost.sent).toHaveLength(1);

    const limited = setup([{ ok: false, code: "browser_live_rate_limited" }]);
    limited.queue.push({ kind: "text", text: "a" }, { kind: "text", text: "b" });
    await limited.settle();
    expect(limited.refused).toHaveBeenCalledWith("browser_live_rate_limited");
    expect(limited.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(limited.sent).toHaveLength(2);
  });
});
