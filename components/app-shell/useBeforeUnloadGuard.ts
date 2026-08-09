"use client";

import { useEffect, useRef } from "react";

const activeGuards = new Map<symbol, () => boolean>();
let listeningWindow: Window | null = null;

function hasDirtyGuard(): boolean {
  return [...activeGuards.values()].some((isDirty) => isDirty());
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!hasDirtyGuard()) return;

  event.preventDefault();
  event.returnValue = "";
}

function syncListener() {
  if (typeof window === "undefined") return;

  if (activeGuards.size > 0 && listeningWindow === null) {
    window.addEventListener("beforeunload", handleBeforeUnload);
    listeningWindow = window;
    return;
  }

  if (activeGuards.size === 0 && listeningWindow !== null) {
    listeningWindow.removeEventListener("beforeunload", handleBeforeUnload);
    listeningWindow = null;
  }
}

/**
 * Owns the document-level navigation prompt for volatile drafts. Callers may
 * provide a predicate when confirmed in-app navigation must clear the guard
 * synchronously before the browser processes the resulting document exit.
 */
export function useBeforeUnloadGuard(dirty: boolean, isDirty: () => boolean = () => dirty) {
  const dirtyRef = useRef(isDirty);

  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    if (!dirty) return;

    const id = Symbol("beforeunload-guard");
    activeGuards.set(id, () => dirtyRef.current());
    syncListener();

    return () => {
      activeGuards.delete(id);
      syncListener();
    };
  }, [dirty]);
}
