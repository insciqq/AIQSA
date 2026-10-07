"use client";

import { useEffect, useSyncExternalStore } from "react";
import { sharedReadAloudController, type ReadAloudController } from "./readAloudController";

export type AnswerReadAloud = Readonly<{
  /** The answer currently speaking, if any. */
  activeId: string | null;
  toggle(id: string, markdown: string): void;
}>;

const noSubscription = () => () => undefined;
const idle = () => null;

/**
 * Read-aloud for the conversation view, or `null` when the browser has no
 * speech synthesis (and during server rendering). Speech stops when the chat
 * changes, a new run starts in it, the speaking answer leaves the thread, and
 * when the view unmounts; the controller itself stops on page hide.
 */
export function useAnswerReadAloud({
  chatKey,
  hasMessage,
  runActive
}: Readonly<{
  chatKey: string | null;
  hasMessage(id: string): boolean;
  runActive: boolean;
}>): AnswerReadAloud | null {
  const controller: ReadAloudController | null = useSyncExternalStore(
    noSubscription,
    sharedReadAloudController,
    idle
  );
  const activeId = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.activeId ?? idle,
    idle
  );

  useEffect(() => () => controller?.stop(), [chatKey, controller]);

  useEffect(() => {
    if (runActive) controller?.stop();
  }, [controller, runActive]);

  const speakingGone = activeId !== null && !hasMessage(activeId);
  useEffect(() => {
    if (speakingGone) controller?.stop();
  }, [controller, speakingGone]);

  return controller ? { activeId, toggle: controller.toggle } : null;
}
