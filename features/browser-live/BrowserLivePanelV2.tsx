"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { BrowserLiveHandoff, BrowserLiveInput, BrowserLiveStep } from "@/lib/contracts/browserLive";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import type { BrowserLiveEventSourceFactory, BrowserLiveSnapshot } from "./browserLiveClient";
import {
  BrowserLivePointerGesture,
  framePointV2,
  keyDownInputV2,
  keyPressInputsV2,
  keyUpInputV2,
  modifiersV2,
  textInputsV2,
  wheelPixelsV2,
  type GestureOutput
} from "./browserLiveInput";
import {
  BROWSER_SIGN_IN_NOT_REMEMBERED_V2,
  browserHandoffCountdownV2,
  browserHandoffTitleV2,
  browserLiveActivityV2,
  browserLiveEndCopyV2,
  browserLiveErrorCopyV2,
  browserLiveHostV2,
  browserLiveStepPhraseV2
} from "./browserLivePresentation";
import { useBrowserLive, type BrowserLiveController } from "./useBrowserLive";

const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
const ZOOM_MAX = 4;
const ESCAPE_TWICE_MS = 600;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(1, Math.round(value * 100) / 100));
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function HandoffCardV2({ handoff, host, live, remembered }: Readonly<{
  handoff: BrowserLiveHandoff;
  host: string | null;
  live: BrowserLiveController;
  remembered: boolean;
}>) {
  const titleId = useId();
  const now = useNow(true);
  const countdown = browserHandoffCountdownV2(handoff.expiresAt, now);
  const title = browserHandoffTitleV2(handoff.reason, host);
  const busy = live.busy === "done" || live.busy === "cancel";
  return (
    <section aria-labelledby={titleId} className="v2-browser-live-handoff" data-reason={handoff.reason}
      data-testid="browser-live-handoff">
      <div className="v2-browser-live-handoff-heading">
        <UiV2Icon name="user" />
        <h3 id={titleId}>{title}</h3>
        <span className="v2-browser-live-countdown" data-expired={countdown.expired || undefined}>{countdown.label}</span>
      </div>
      {handoff.message ? <p className="v2-browser-live-handoff-message">{handoff.message}</p> : null}
      <p className="v2-browser-live-handoff-hint">You have control. Use the browser below, then press Done. The agent never sees what you type.</p>
      {remembered ? null : <p className="v2-browser-live-handoff-note" role="note">{BROWSER_SIGN_IN_NOT_REMEMBERED_V2}</p>}
      <div aria-labelledby={titleId} className="v2-browser-live-handoff-actions" role="group">
        <UiV2Button busy={live.busy === "cancel"} disabled={busy || countdown.expired}
          onClick={() => void live.answerHandoff(handoff.id, "cancel")} type="button">Cancel</UiV2Button>
        <UiV2Button busy={live.busy === "done"} disabled={busy || countdown.expired}
          data-browser-live-exit="" onClick={() => void live.answerHandoff(handoff.id, "done")} tone="primary" type="button">Done</UiV2Button>
      </div>
    </section>
  );
}

/** Typing on phones: a real text field raises the on-screen keyboard and sends what it types. */
function BrowserLiveTypingV2({ onInputs }: Readonly<{ onInputs(...inputs: BrowserLiveInput[]): void }>) {
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const sendRef = useRef(onInputs);
  useEffect(() => {
    sendRef.current = onInputs;
  }, [onInputs]);

  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    const reset = () => {
      field.value = "";
    };
    const beforeInput = (event: Event) => {
      const input = event as InputEvent;
      if (composingRef.current || input.isComposing) return;
      if ((input.inputType === "insertText" || input.inputType === "insertReplacementText") && input.data) {
        event.preventDefault();
        sendRef.current(...textInputsV2(input.data));
      } else if (input.inputType === "deleteContentBackward") {
        event.preventDefault();
        sendRef.current(...keyPressInputsV2("Backspace"));
      } else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") {
        event.preventDefault();
        sendRef.current(...keyPressInputsV2("Enter"));
      } else if (input.inputType === "insertFromPaste" && input.data) {
        event.preventDefault();
        sendRef.current(...textInputsV2(input.data));
      }
    };
    const compositionStart = () => {
      composingRef.current = true;
    };
    const compositionEnd = (event: Event) => {
      composingRef.current = false;
      const data = (event as CompositionEvent).data;
      if (data) sendRef.current(...textInputsV2(data));
      reset();
    };
    // Whatever the field kept (an uncancelable insertion) was sent or is composing; it never accumulates.
    const input = () => {
      if (!composingRef.current) reset();
    };
    field.addEventListener("beforeinput", beforeInput);
    field.addEventListener("compositionstart", compositionStart);
    field.addEventListener("compositionend", compositionEnd);
    field.addEventListener("input", input);
    return () => {
      field.removeEventListener("beforeinput", beforeInput);
      field.removeEventListener("compositionstart", compositionStart);
      field.removeEventListener("compositionend", compositionEnd);
      field.removeEventListener("input", input);
    };
  }, []);

  const press = (key: "Backspace" | "Enter" | "Tab") => () => {
    onInputs(...keyPressInputsV2(key));
    inputRef.current?.focus();
  };

  return (
    <div className="v2-browser-live-typing" data-testid="browser-live-typing">
      <label className="v2-sr-only" htmlFor={fieldId}>Type into the page</label>
      <input
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="v2-browser-live-typing-field v2-focusable"
        enterKeyHint="enter"
        id={fieldId}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onInputs(...keyPressInputsV2("Enter", modifiersV2(event)));
          } else if (event.key === "Backspace" && !event.currentTarget.value) {
            // A hardware Backspace on an empty field has no input event to carry it.
            event.preventDefault();
            onInputs(...keyPressInputsV2("Backspace"));
          }
        }}
        placeholder="Type into the page"
        ref={inputRef}
        spellCheck={false}
        type="text"
      />
      <div className="v2-browser-live-typing-keys" role="group" aria-label="Keys">
        <UiV2Button aria-label="Press Tab in the page" onClick={press("Tab")} type="button">Tab</UiV2Button>
        <UiV2Button aria-label="Press Backspace in the page" onClick={press("Backspace")} type="button">⌫</UiV2Button>
        <UiV2Button aria-label="Press Enter in the page" onClick={press("Enter")} type="button">Enter</UiV2Button>
      </div>
    </div>
  );
}

function StepsV2({ steps }: Readonly<{ steps: readonly BrowserLiveStep[] }>) {
  if (steps.length === 0) return null;
  const last = steps.at(-1)!;
  return (
    <details className="v2-browser-live-steps">
      <summary className="v2-focusable">
        <span>{steps.length === 1 ? "1 step" : `${steps.length} steps`}</span>
        <span className="v2-browser-live-steps-last">{browserLiveStepPhraseV2(last)}</span>
      </summary>
      <ol aria-label="Browser steps">
        {steps.map((step) => <li key={step.n} value={step.n}>{browserLiveStepPhraseV2(step)}</li>)}
      </ol>
    </details>
  );
}

function placeholderCopy(snapshot: BrowserLiveSnapshot): Readonly<{ text: string; busy: boolean; reopen: string | null }> | null {
  if (snapshot.connection === "ended" && snapshot.endReason) {
    const copy = browserLiveEndCopyV2(snapshot.endReason);
    return { text: copy.text, busy: false, reopen: copy.reopen };
  }
  if (snapshot.connection === "failed") return { text: "The live view could not connect.", busy: false, reopen: "Retry" };
  if (!snapshot.state) return { text: "Connecting to the browser…", busy: true, reopen: null };
  if (snapshot.state.browser === "absent") return { text: "The browser has not opened yet. It shows here once the agent opens a page.", busy: false, reopen: null };
  if (snapshot.state.browser === "stopped") return { text: "The browser was closed.", busy: false, reopen: null };
  if (!snapshot.frame) return { text: "Waiting for the page picture…", busy: true, reopen: null };
  return null;
}

function announcement(snapshot: BrowserLiveSnapshot, host: string | null): string {
  if (snapshot.connection === "ended" && snapshot.endReason) return browserLiveEndCopyV2(snapshot.endReason).text;
  if (snapshot.connection === "failed") return "The live view could not connect.";
  const state = snapshot.state;
  if (!state || state.browser !== "running") return "";
  if (state.handoff) return `The agent needs your help: ${browserHandoffTitleV2(state.handoff.reason, host)}.`;
  return state.controller === "user" ? "You have control of the browser." : "The agent has control of the browser.";
}

function LiveViewV2({ live }: Readonly<{ live: BrowserLiveController }>) {
  const { snapshot } = live;
  const state = snapshot.state;
  const frame = snapshot.connection === "ended" || snapshot.connection === "failed" ? null : snapshot.frame;
  const running = state?.browser === "running" && (snapshot.connection === "live" || snapshot.connection === "reconnecting");
  const userControls = running && snapshot.connection === "live" && state?.controller === "user";
  const handoff = running ? state?.handoff ?? null : null;
  const host = browserLiveHostV2(state?.page?.url);
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const gestureRef = useRef(new BrowserLivePointerGesture());
  const pressedKeysRef = useRef(new Set<string>());
  const lastEscapeRef = useRef(0);
  const zoomAnchorRef = useRef<{ x: number; y: number; from: number } | null>(null);
  const placeholder = placeholderCopy(snapshot);
  const sendInput = live.sendInput;

  useEffect(() => {
    gestureRef.current.reset();
    pressedKeysRef.current.clear();
  }, [userControls]);

  // Zooming keeps the point under the fingers (or the frame's centre) in place.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    if (!stage || !anchor || anchor.from === zoom) return;
    stage.scrollLeft = (stage.scrollLeft + anchor.x) * zoom / anchor.from - anchor.x;
    stage.scrollTop = (stage.scrollTop + anchor.y) * zoom / anchor.from - anchor.y;
  }, [zoom]);

  /** Zooms to a level, or by a factor of the current one (pinch moves arrive faster than renders). */
  const zoomTo = useCallback((next: number | ((current: number) => number), clientX?: number, clientY?: number) => {
    const stage = stageRef.current;
    setZoom((current) => {
      const value = typeof next === "function" ? next(current) : next;
      const target = clampZoom(value > 0 ? value : 1);
      if (stage && target !== current) {
        const rect = stage.getBoundingClientRect();
        zoomAnchorRef.current = {
          from: current,
          x: clientX === undefined ? rect.width / 2 : clientX - rect.left,
          y: clientY === undefined ? rect.height / 2 : clientY - rect.top
        };
      }
      return target;
    });
  }, []);

  const environment = useCallback(() => {
    const image = imageRef.current;
    const rect = image?.getBoundingClientRect();
    return {
      userControls,
      zoomed: zoom > 1,
      scale: frame && rect && rect.width > 0 ? frame.width / rect.width : 1,
      now: Date.now(),
      toFrame: (clientX: number, clientY: number) => frame && rect ? framePointV2(clientX, clientY, rect, frame) : null
    };
  }, [frame, userControls, zoom]);

  const apply = useCallback((output: GestureOutput) => {
    if (output.inputs.length > 0) sendInput(...output.inputs);
    const zoomBy = output.zoomBy;
    if (zoomBy) zoomTo((current) => current * zoomBy.factor, zoomBy.clientX, zoomBy.clientY);
    if (output.panBy && stageRef.current) {
      stageRef.current.scrollLeft += output.panBy.dx;
      stageRef.current.scrollTop += output.panBy.dy;
    }
  }, [sendInput, zoomTo]);

  // Wheel needs a non-passive listener: while the user controls the page, it scrolls the page, not the chat.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey && !userControls) {
        // A trackpad pinch zooms the frame.
        event.preventDefault();
        zoomTo((current) => current * Math.exp(-event.deltaY / 200), event.clientX, event.clientY);
        return;
      }
      if (!userControls || !frame) return;
      const env = environment();
      const point = env.toFrame(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const modifiers = modifiersV2(event);
      sendInput({ kind: "mouse", type: "wheel", x: point.x, y: point.y,
        deltaX: wheelPixelsV2(event.deltaX, event.deltaMode, frame.height),
        deltaY: wheelPixelsV2(event.deltaY, event.deltaMode, frame.height),
        ...(modifiers ? { modifiers } : {}) });
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [environment, frame, sendInput, userControls, zoomTo]);

  const pointer = (kind: "down" | "move" | "up" | "cancel", event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    const env = environment();
    if (kind === "down" && userControls && event.pointerType !== "touch") {
      try {
        // Release outside the frame still ends the click or drag.
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone.
      }
      event.currentTarget.focus({ preventScroll: true });
    }
    const gesture = gestureRef.current;
    const output = kind === "down" ? gesture.down(event, env)
      : kind === "move" ? gesture.move(event, env)
      : gesture.up(event, env, kind === "cancel");
    if (userControls && kind === "down" && event.pointerType !== "touch") event.preventDefault();
    apply(output);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!userControls || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      const now = Date.now();
      if (now - lastEscapeRef.current <= ESCAPE_TWICE_MS) {
        // Escape twice leaves the view without trapping keyboard users.
        event.preventDefault();
        lastEscapeRef.current = 0;
        // To Return control, or to Done during a handoff.
        stageRef.current?.parentElement?.querySelector<HTMLButtonElement>("[data-browser-live-exit]")?.focus();
        return;
      }
      lastEscapeRef.current = now;
    }
    const input = keyDownInputV2(event);
    if (!input) return;
    event.preventDefault();
    if (input.kind === "key") pressedKeysRef.current.add(event.code || event.key);
    sendInput(input);
  };

  const keyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const id = event.code || event.key;
    if (!pressedKeysRef.current.delete(id) || !userControls) return;
    event.preventDefault();
    sendInput(keyUpInputV2(event));
  };

  const stageStyle = {
    "--v2-browser-live-w": frame?.width ?? 16,
    "--v2-browser-live-h": frame?.height ?? 10
  } as CSSProperties;
  const label = state?.page?.title ? `Live view of the agent's browser: ${state.page.title}` : "Live view of the agent's browser";
  const zoomIndex = ZOOM_STEPS.findIndex((step) => step >= zoom - 0.001);
  const showsFrame = Boolean(frame && !placeholder);

  return (
    <div className="v2-browser-live-view">
      {handoff ? <HandoffCardV2 handoff={handoff} host={host} live={live} remembered={state?.signInRemembered !== false} /> : null}
      {state?.page && running ? (
        <p className="v2-browser-live-address">
          {state.page.title ? <span className="v2-browser-live-title">{state.page.title}</span> : null}
          <span className="v2-browser-live-url">{state.page.url}</span>
        </p>
      ) : null}
      {running ? (
        <div className="v2-browser-live-toolbar">
          <span className="v2-browser-live-controller" data-controller={state?.controller}>
            {handoff ? "You have control" : userControls ? "You have control · the agent waits"
              : snapshot.connection === "reconnecting" ? "Reconnecting…" : "The agent is using the browser"}
          </span>
          {handoff ? null : userControls ? (
            <UiV2Button busy={live.busy === "return"} disabled={live.busy !== null} onClick={() => void live.control("return")}
              data-browser-live-exit="" type="button">Return control</UiV2Button>
          ) : (
            <UiV2Button busy={live.busy === "take"} disabled={live.busy !== null || snapshot.connection !== "live"}
              onClick={() => void live.control("take")} tone="primary" type="button">Take control</UiV2Button>
          )}
          <div className="v2-browser-live-zoom" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" className="v2-browser-live-zoom-button v2-focusable" disabled={zoom <= 1}
              onClick={() => zoomTo(ZOOM_STEPS[Math.max(0, (zoomIndex < 0 ? ZOOM_STEPS.length : zoomIndex) - 1)] ?? 1)}
              type="button">−</button>
            <button aria-label="Fit the page to the panel" className="v2-browser-live-zoom-button v2-browser-live-zoom-fit v2-focusable"
              disabled={zoom === 1} onClick={() => zoomTo(1)} type="button">{Math.round(zoom * 100)}%</button>
            <button aria-label="Zoom in" className="v2-browser-live-zoom-button v2-focusable" disabled={zoom >= ZOOM_MAX}
              onClick={() => zoomTo(ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? ZOOM_MAX)} type="button">+</button>
          </div>
        </div>
      ) : null}
      {live.failure ? <p className="v2-browser-live-error" role="alert">{browserLiveErrorCopyV2(live.failure)}</p> : null}
      {/* Above the frame, so the composer dock or an on-screen keyboard never hides the field under it. */}
      {userControls ? <BrowserLiveTypingV2 onInputs={sendInput} /> : null}
      <div
        aria-label={showsFrame ? label : undefined}
        aria-roledescription={showsFrame ? "live browser" : undefined}
        className="v2-browser-live-stage v2-focusable"
        data-control={userControls ? "user" : "agent"}
        data-reconnecting={snapshot.connection === "reconnecting" || undefined}
        data-testid="browser-live-stage"
        data-zoomed={zoom > 1 || undefined}
        onContextMenu={(event) => { if (userControls) event.preventDefault(); }}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onPaste={(event) => {
          if (!userControls) return;
          event.preventDefault();
          sendInput(...textInputsV2(event.clipboardData.getData("text/plain")));
        }}
        onPointerCancel={(event) => pointer("cancel", event)}
        onPointerDown={(event) => pointer("down", event)}
        onPointerMove={(event) => pointer("move", event)}
        onPointerUp={(event) => pointer("up", event)}
        ref={stageRef}
        role={showsFrame ? userControls ? "application" : "img" : undefined}
        style={stageStyle}
        tabIndex={showsFrame ? 0 : -1}
      >
        {frame && showsFrame ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live in-memory frame, never a static asset
          <img alt="" className="v2-browser-live-frame" draggable={false} height={frame.height} ref={imageRef}
            src={`data:${frame.mime};base64,${frame.data}`} style={{ width: `${zoom * 100}%` }} width={frame.width} />
        ) : placeholder ? (
          <div className="v2-browser-live-placeholder">
            {placeholder.busy ? <span aria-hidden="true" className="v2-spinner" /> : null}
            <p>{placeholder.text}</p>
            {placeholder.reopen ? <UiV2Button onClick={live.reopen} type="button">{placeholder.reopen}</UiV2Button> : null}
          </div>
        ) : null}
      </div>
      {userControls ? <p className="v2-browser-live-hint">Click the page, then type. Press Esc twice to leave the view.</p> : null}
      <StepsV2 steps={snapshot.steps} />
      <p aria-atomic="true" aria-live="polite" className="v2-sr-only" role="status">{announcement(snapshot, host)}</p>
    </div>
  );
}

export type BrowserLivePanelV2Props = Readonly<{
  chatId: string;
  /** The answer's run is live; the bar disappears once it ends. */
  live: boolean;
  toolActivity: ThreadToolActivity | null;
  workspaceActivity: ThreadWorkspaceActivity | null;
  /** Tests inject a fake `EventSource`. */
  openEventSource?: BrowserLiveEventSourceFactory;
}>;

/**
 * The live Workspace browser of the answer that is running: a compact bar
 * while the agent browses, expanded on demand (frames stream only then) or
 * automatically when the agent hands the browser to the user.
 */
export function BrowserLivePanelV2({ chatId, live: runLive, openEventSource, toolActivity, workspaceActivity }: BrowserLivePanelV2Props) {
  const activity = browserLiveActivityV2(toolActivity, workspaceActivity);
  const visible = runLive && activity.visible;
  const [expanded, setExpanded] = useState(false);
  const autoOpenedRef = useRef<string | null>(null);
  const panelId = useId();
  const live = useBrowserLive(chatId, visible && expanded, openEventSource);
  const streamHandoff = live.snapshot.state?.handoff?.id ?? null;

  // A pending handoff opens the panel once; the user may close it again.
  useEffect(() => {
    const key = activity.pendingHandoffKey ?? (streamHandoff ? `stream:${streamHandoff}` : null);
    if (!key || autoOpenedRef.current === key) return;
    autoOpenedRef.current = key;
    setExpanded(true);
  }, [activity.pendingHandoffKey, streamHandoff]);

  if (!visible) return null;
  const state = expanded ? live.snapshot.state : null;
  const needsUser = Boolean(activity.pendingHandoffKey || state?.handoff);
  const status = needsUser ? "Needs your help"
    : state?.controller === "user" && state.browser === "running" ? "You have control"
    : activity.lastStep ?? "The agent is using the browser";
  return (
    <section aria-label="Browser" className="v2-browser-live" data-expanded={expanded || undefined}
      data-needs-user={needsUser || undefined} data-testid="browser-live">
      <button aria-controls={expanded ? panelId : undefined} aria-expanded={expanded} className="v2-browser-live-bar v2-focusable"
        onClick={() => setExpanded((current) => !current)} type="button">
        <UiV2Icon name="globe" />
        <span className="v2-browser-live-bar-title">Browser</span>
        <span className="v2-browser-live-bar-status">{status}</span>
        <span className="v2-browser-live-bar-action">{expanded ? "Hide" : "Watch"}</span>
        <UiV2Icon name="chevron-down" />
      </button>
      {expanded ? <div className="v2-browser-live-panel" id={panelId}><LiveViewV2 live={live} /></div> : null}
    </section>
  );
}
