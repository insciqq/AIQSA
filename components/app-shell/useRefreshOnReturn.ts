import { useEffect, useRef } from "react";

/** Installation Workspace availability is read again on return at most this often. */
export const WORKSPACE_AVAILABILITY_RETURN_INTERVAL_MS = 30_000;

/**
 * Calls `refresh` when the window regains focus or the page becomes visible,
 * at most once per `minIntervalMs` (mounting counts as a read, since the
 * owner reads on mount). A hidden page never refreshes.
 */
export function useRefreshOnReturn(refresh: () => void, minIntervalMs: number): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    let lastRead = Date.now();
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRead < minIntervalMs) return;
      lastRead = now;
      refreshRef.current();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [minIntervalMs]);
}
