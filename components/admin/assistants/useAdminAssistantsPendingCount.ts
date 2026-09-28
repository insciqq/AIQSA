import { loadAdminAssistantsPendingCount } from "@/components/admin/assistants/adminAssistantsApi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminAssistantsPendingCount = Readonly<{
  count: number;
  /** A fresher count observed elsewhere (the section's own list or the attention list). */
  report(count: number): void;
}>;

/**
 * Sidebar count of listing requests an administrator can decide. It loads once
 * the Control Center data is available and again after every reconciled
 * mutation; the section and the attention list report newer counts they see.
 */
export function useAdminAssistantsPendingCount({ enabled, refreshKey }: Readonly<{
  enabled: boolean;
  refreshKey: number | null;
}>): AdminAssistantsPendingCount {
  const [count, setCount] = useState(0);
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const sequence = ++sequenceRef.current;
    loadAdminAssistantsPendingCount(controller.signal)
      .then((pending) => {
        if (sequence === sequenceRef.current) setCount(pending);
      })
      // The count is a hint; the section itself reports failures.
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, refreshKey]);

  const report = useCallback((next: number) => {
    // A reported count supersedes a load still in flight.
    sequenceRef.current += 1;
    setCount(next);
  }, []);

  return useMemo(() => ({ count, report }), [count, report]);
}
