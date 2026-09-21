"use client";

import { useCallback, useRef, useState } from "react";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { initialStudioSection, rememberStudioSection } from "@/components/app-shell/shellStorage";
import type { LibraryTabIdV2, StudioNavigationV2 } from "./contracts";

/** Resource owners register their current draft/mutation guard while Studio is mounted. */
export function useStudioNavigation({ available, onSelect, onExit }: Readonly<{
  available: readonly LibraryTabIdV2[];
  onSelect(tab: LibraryTabIdV2): void;
  onExit(): void;
}>): StudioNavigationV2 {
  const [tab, setTab] = useState<LibraryTabIdV2>("assistants");
  const [busy, setBusy] = useState(false);
  const resource = useRef<{ guard: ((proceed: () => void) => void) | null; busy: boolean }>({ guard: null, busy: false });
  const registerGuard = useCallback<StudioNavigationV2["registerGuard"]>((guard, nextBusy) => {
    resource.current = { guard, busy: nextBusy };
    setBusy(nextBusy);
  }, []);
  const open = useEventCallback<Parameters<StudioNavigationV2["open"]>, void>((target, afterSelect) => {
    if (resource.current.busy) return;
    // Choosing the current rail destination leaves its subview and draft intact.
    if (resource.current.guard && !afterSelect && (!target || target === tab)) return;
    const next = initialStudioSection(available, target);
    if (!next) return;
    const proceed = () => {
      onSelect(next);
      setTab(next);
      rememberStudioSection(next);
      afterSelect?.();
    };
    if (resource.current.guard) resource.current.guard(proceed);
    else proceed();
  });
  const exit = useEventCallback<Parameters<StudioNavigationV2["exit"]>, void>((afterExit) => {
    if (resource.current.busy) return;
    const proceed = () => { onExit(); afterExit?.(); };
    if (resource.current.guard) resource.current.guard(proceed);
    else proceed();
  });
  return { tab, busy, open, exit, registerGuard };
}
