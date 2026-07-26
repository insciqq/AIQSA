"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminOperationalFocusTarget =
  | "group-detail"
  | "user-detail"
  | "user-groups";

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
  const userDetailRef = useRef<HTMLElement | null>(null);
  const userGroupsRef = useRef<HTMLDivElement | null>(null);
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
      if (target === "user-groups") {
        focusAdminElement(userGroupsRef.current);
        return;
      }

      if (target === "group-detail") {
        focusAdminElement(groupDetailRef.current);
        return;
      }

      focusAdminElement(userDetailRef.current);
    });
  }, [requestRevision]);

  const focus = useMemo(
    () => ({
      groups: {
        detail: groupDetailRef
      },
      users: {
        detail: userDetailRef,
        groupsEditor: userGroupsRef
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
