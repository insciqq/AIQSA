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

export type BrowserLiveController = Readonly<{
  snapshot: BrowserLiveSnapshot;
  /** The action whose request is in flight; its control stays busy. */
  busy: BrowserLiveAction | null;
  /** The latest refusal to show, until the next action or state change clears it. */
  failure: BrowserLiveFailureCodeV2 | null;
  clearFailure(): void;
  sendInput(...inputs: BrowserLiveInput[]): void;
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

  // One stream per open panel of a chat, and one input queue beside it.
  const stream = useMemo(() => open ? new BrowserLiveStream(chatId, openEventSource) : null, [chatId, open, openEventSource]);
  const queueRef = useRef<BrowserLiveInputQueue | null>(null);
  useEffect(() => {
    if (!stream) return;
    const queue = new BrowserLiveInputQueue({
      send: (input) => postBrowserLiveInput(chatId, input),
      onRefused: (code) => setFailureEntry({ code, state: stateRef.current, stream })
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

  const run = useCallback(async (action: BrowserLiveAction, request: () => Promise<BrowserLiveRequestResult>) => {
    const requestStream = streamRef.current;
    if (!requestStream || busyRef.current === requestStream) return;
    busyRef.current = requestStream;
    setBusyEntry({ action, stream: requestStream });
    setFailureEntry(null);
    try {
      const result = await request();
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
    if (userControls && inputs.length > 0) queueRef.current?.push(...inputs);
  }, [userControls]);
  const reopen = useCallback(() => {
    setFailureEntry(null);
    stream?.restart();
  }, [stream]);
  const clearFailure = useCallback(() => setFailureEntry(null), []);

  return { snapshot, busy, failure, clearFailure, sendInput, control, answerHandoff, reopen };
}
