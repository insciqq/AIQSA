"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BrowserLiveInput, BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import {
  BROWSER_LIVE_IDLE_SNAPSHOT,
  BrowserLiveStream,
  postBrowserLiveControl,
  postBrowserLiveHandoff,
  postBrowserLiveInput,
  type BrowserLiveEventSourceFactory,
  type BrowserLiveRequestResult,
  type BrowserLiveSnapshot
} from "./browserLiveClient";
import { BrowserLiveInputQueue } from "./browserLiveInput";
import type { BrowserLiveFailureCodeV2 } from "./browserLivePresentation";

export type BrowserLiveAction = "take" | "return" | "done" | "cancel";

/** How long Done and Return control wait for queued input to arrive before they end control anyway. */
export const BROWSER_LIVE_END_DRAIN_MS = 2_000;

export type BrowserLiveController = Readonly<{
  snapshot: BrowserLiveSnapshot;
  /** The action whose request is in flight; its control stays busy. */
  busy: BrowserLiveAction | null;
  /** The latest refusal to show, until the next action or state change clears it. */
  failure: BrowserLiveFailureCodeV2 | null;
  sendInput(...inputs: BrowserLiveInput[]): void;
  /** Sends releases (key up, mouse up) straight away, in order, when the panel closes while the user controls. */
  releaseNow(...inputs: BrowserLiveInput[]): void;
  control(action: "take" | "return"): Promise<void>;
  answerHandoff(handoffId: string, action: "done" | "cancel"): Promise<void>;
  reopen(): void;
}>;

type FailureEntry = Readonly<{
  code: BrowserLiveFailureCodeV2;
  /** The state the refusal answered; a newer state hides it. */
  state: BrowserLiveStateEvent | null;
  stream: BrowserLiveStream;
}>;

const NOOP_SUBSCRIBE = () => () => undefined;
const IDLE = () => BROWSER_LIVE_IDLE_SNAPSHOT;

/**
 * The live browser of one chat while its panel is open: the stream exists only
 * while `open` is true (frames flow only then) and is keyed by the chat, so a
 * navigation never shows another chat's browser. Input is queued in order and
 * dropped when the user no longer controls the browser.
 */
export function useBrowserLive(
  chatId: string,
  open: boolean,
  openEventSource?: BrowserLiveEventSourceFactory
): BrowserLiveController {
  const [busyEntry, setBusyEntry] = useState<{ action: BrowserLiveAction; stream: BrowserLiveStream } | null>(null);
  const [failureEntry, setFailureEntry] = useState<FailureEntry | null>(null);
  const stateRef = useRef<BrowserLiveStateEvent | null>(null);
  const streamRef = useRef<BrowserLiveStream | null>(null);
  const busyRef = useRef<BrowserLiveStream | null>(null);
  /**
   * Set the moment the user ends control (Done, Cancel, Return control): new input is refused at once, and a
   * late `browser_live_not_in_control` is the user's own doing, not news. Cleared when a new control period
   * starts (the agent held the browser, then the user has it again), on Take control, or when ending failed.
   */
  const endingRef = useRef<{ sawAgent: boolean } | null>(null);

  // One stream per open panel of a chat, and one input queue beside it.
  const stream = useMemo(() => open ? new BrowserLiveStream(chatId, openEventSource) : null, [chatId, open, openEventSource]);
  const queueRef = useRef<BrowserLiveInputQueue | null>(null);
  useEffect(() => {
    if (!stream) return;
    // A newly opened panel starts from the state it receives, not from an end the closed one saw begin.
    endingRef.current = null;
    const queue = new BrowserLiveInputQueue({
      send: (input) => postBrowserLiveInput(chatId, input),
      onRefused: (code) => {
        if (code === "browser_live_not_in_control" && endingRef.current) return;
        setFailureEntry({ code, state: stateRef.current, stream });
      },
      // An accepted send ends "too much input at once".
      onAccepted: () => setFailureEntry((current) => current?.code === "browser_live_rate_limited" ? null : current)
    });
    queueRef.current = queue;
    stream.start();
    return () => {
      stream.stop();
      queue.close();
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [chatId, stream]);
  const snapshot = useSyncExternalStore(stream?.subscribe ?? NOOP_SUBSCRIBE, stream?.getSnapshot ?? IDLE, IDLE);
  useEffect(() => {
    stateRef.current = snapshot.state;
    streamRef.current = stream;
    const ending = endingRef.current;
    if (ending && snapshot.state?.controller === "agent") ending.sawAgent = true;
    else if (ending?.sawAgent && snapshot.state?.controller === "user") endingRef.current = null;
  }, [snapshot.state, stream]);

  const userControls = snapshot.state?.controller === "user" && snapshot.state.browser === "running" &&
    snapshot.connection === "live";
  useEffect(() => {
    // Input typed for the user's turn never reaches the agent's.
    if (!userControls) queueRef.current?.clear();
  }, [stream, userControls]);

  // Busy and refusals belong to the open stream; a state change (control moved, handoff answered)
  // supersedes an older refusal, except a rate limit, which is about the person's own pace.
  const busy = busyEntry && busyEntry.stream === stream ? busyEntry.action : null;
  const failure = failureEntry && failureEntry.stream === stream &&
    (failureEntry.code === "browser_live_rate_limited" || failureEntry.state === snapshot.state) ? failureEntry.code : null;

  /**
   * One control request. Ending control blocks input at once; Done and Return first let queued input
   * (the last code digits, the click on the page's own button) arrive, for at most a bounded wait, while
   * Cancel drops it.
   */
  const run = useCallback(async (action: BrowserLiveAction, request: () => Promise<BrowserLiveRequestResult>) => {
    const requestStream = streamRef.current;
    if (!requestStream || busyRef.current === requestStream) return;
    busyRef.current = requestStream;
    setBusyEntry({ action, stream: requestStream });
    setFailureEntry(null);
    const queue = queueRef.current;
    endingRef.current = action === "take" ? null : { sawAgent: false };
    try {
      if (action === "cancel") queue?.clear();
      else if (action !== "take" && queue && !await queue.drain(BROWSER_LIVE_END_DRAIN_MS)) queue.clear();
      const result = await request();
      // A refused end that left the user in control (a network failure) gives the browser back to them.
      if (!result.ok && action !== "take" && result.code !== "browser_live_handoff_stale" &&
        result.code !== "browser_live_not_in_control") endingRef.current = null;
      if (!result.ok && streamRef.current === requestStream) {
        setFailureEntry({ code: result.code, state: stateRef.current, stream: requestStream });
      }
    } finally {
      if (busyRef.current === requestStream) busyRef.current = null;
      setBusyEntry((current) => current?.stream === requestStream ? null : current);
    }
  }, []);

  const control = useCallback((action: "take" | "return") =>
    run(action, () => postBrowserLiveControl(chatId, action)), [chatId, run]);
  const answerHandoff = useCallback((handoffId: string, action: "done" | "cancel") =>
    run(action, () => postBrowserLiveHandoff(chatId, handoffId, action)), [chatId, run]);
  const sendInput = useCallback((...inputs: BrowserLiveInput[]) => {
    if (userControls && !endingRef.current && inputs.length > 0) queueRef.current?.push(...inputs);
  }, [userControls]);
  const releaseNow = useCallback((...inputs: BrowserLiveInput[]) => {
    if (!userControls || endingRef.current) return;
    // Best effort and in order; nothing waits for the answers.
    void inputs.reduce<Promise<unknown>>((previous, input) =>
      previous.then(() => postBrowserLiveInput(chatId, input)), Promise.resolve());
  }, [chatId, userControls]);
  const reopen = useCallback(() => {
    setFailureEntry(null);
    stream?.restart();
  }, [stream]);

  return { snapshot, busy, failure, sendInput, releaseNow, control, answerHandoff, reopen };
}
