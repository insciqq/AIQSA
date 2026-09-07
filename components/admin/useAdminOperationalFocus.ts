"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminOperationalFocusTarget = "group-detail";

export function focusAdminElement(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  element.scrollIntoView?.({
    block: "start"
  });
  element.focus({
    preventScroll: true
  });
}

function scheduleFocus(callback: () => void) {
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(callback);
    return;
  }

  window.setTimeout(callback, 0);
}

export function useAdminOperationalFocus() {
  const groupDetailRef = useRef<HTMLElement | null>(null);
  const pendingTargetRef = useRef<AdminOperationalFocusTarget | null>(null);
  const [requestRevision, setRequestRevision] = useState(0);

  const requestFocus = useCallback((target: AdminOperationalFocusTarget) => {
    pendingTargetRef.current = target;
    setRequestRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const target = pendingTargetRef.current;

    if (!target) {
      return;
    }

    pendingTargetRef.current = null;
    scheduleFocus(() => {
      focusAdminElement(groupDetailRef.current);
    });
  }, [requestRevision]);

  const focus = useMemo(
    () => ({
      groups: {
        detail: groupDetailRef
      }
    }),
    []
  );

  return useMemo(
    () => ({
      focus,
      requestFocus
    }),
    [focus, requestFocus]
  );
}
