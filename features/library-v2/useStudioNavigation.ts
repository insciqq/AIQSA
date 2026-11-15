"use client";

import { useCallback, useRef, useState } from "react";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { initialStudioSection, rememberStudioSection } from "@/components/app-shell/shellStorage";
import type { LibraryTabIdV2, StudioNavigationV2 } from "./contracts";

/**
 * The one owner of which Settings section is open. Resource owners register
 * their current draft/mutation guard while Settings is mounted.
 */
export function useStudioNavigation({ available, onSelect, onExit }: Readonly<{
  available: readonly LibraryTabIdV2[];
  onSelect(tab: LibraryTabIdV2): void;
  onExit(): void;
}>): StudioNavigationV2 {
  const [tab, setTab] = useState<LibraryTabIdV2>("general");
  const [sectionShown, setSectionShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const resource = useRef<{ guard: ((proceed: () => void) => void) | null; busy: boolean }>({ guard: null, busy: false });
  const registerGuard = useCallback<StudioNavigationV2["registerGuard"]>((guard, nextBusy) => {
    resource.current = { guard, busy: nextBusy };
    setBusy(nextBusy);
  }, []);
  /** `shown` null keeps the list or section as it is shown. */
  const navigate = useEventCallback((target: LibraryTabIdV2 | undefined, afterSelect: (() => void) | undefined,
    shown: boolean | null) => {
    if (resource.current.busy) return;
    // Choosing the current section leaves its subview and draft intact.
    if (resource.current.guard && !afterSelect && (!target || target === tab)) {
      if (shown && target) setSectionShown(true);
      return;
    }
    const next = initialStudioSection(available, target);
    if (!next) return;
    const proceed = () => {
      onSelect(next);
      setTab(next);
      rememberStudioSection(next);
      // A named section that is not offered opens the list instead.
      if (shown !== null) setSectionShown(shown && next === target);
      afterSelect?.();
    };
    if (resource.current.guard) resource.current.guard(proceed);
    else proceed();
  });
  const open = useEventCallback<Parameters<StudioNavigationV2["open"]>, void>((target, afterSelect) => {
    navigate(target, afterSelect, Boolean(target));
  });
  const select = useEventCallback<Parameters<StudioNavigationV2["select"]>, void>((target, afterSelect) => {
    navigate(target, afterSelect, null);
  });
  const showSection = useCallback((shown: boolean) => setSectionShown(shown), []);
  const exit = useEventCallback<Parameters<StudioNavigationV2["exit"]>, void>((afterExit) => {
    if (resource.current.busy) return;
    const proceed = () => { onExit(); afterExit?.(); };
    if (resource.current.guard) resource.current.guard(proceed);
    else proceed();
  });
  return { tab, busy, sectionShown, open, select, showSection, exit, registerGuard };
}
