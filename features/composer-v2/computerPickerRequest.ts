import { useEffect, useRef } from "react";

/**
 * Opens the composer's computer picker from outside the composer: the
 * "Choose another computer" action a refused send shows next to its reason.
 */
const listeners = new Set<() => void>();

export function requestComposerComputerPicker(): void {
  for (const listener of listeners) listener();
}

/** Calls `onRequest` for each request while the composer is mounted. */
export function useComposerComputerPickerRequests(onRequest: () => void, enabled: boolean): void {
  const latest = useRef(onRequest);
  useEffect(() => {
    latest.current = onRequest;
  });
  useEffect(() => {
    if (!enabled) return;
    const listener = () => latest.current();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);
}
