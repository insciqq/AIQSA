import {
  requestAdminAttention,
  type AdminAttentionResult
} from "@/components/admin/adminAttentionApi";
import { adminAttentionItemSource, type AdminAttention } from "@/lib/contracts/adminAttention";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminAttentionController = Readonly<{
  attention: AdminAttention | null;
  /** True only while nothing has loaded yet; later refreshes keep the list visible. */
  loading: boolean;
  refresh(): Promise<void>;
  unavailable: boolean;
  /** Last successful source observation for retained, currently unconfirmed items. */
  staleItems: Readonly<Record<string, string>>;
}>;

export type UseAdminAttentionOptions = Readonly<{
  active: boolean;
  /** Changes whenever a mutation was reconciled; the list refetches on each change. */
  refreshKey: number | null;
  requestAttention?: () => Promise<AdminAttentionResult>;
}>;

/**
 * Overview data: loads while the Overview is active, refetches after each
 * reconciled mutation and whenever the window regains focus, and ignores
 * responses that arrive after a newer request started.
 */
export function useAdminAttention({
  active,
  refreshKey,
  requestAttention = requestAdminAttention
}: UseAdminAttentionOptions): AdminAttentionController {
  const [attention, setAttention] = useState<AdminAttention | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [settled, setSettled] = useState(false);
  const [staleItems, setStaleItems] = useState<Readonly<Record<string, string>>>({});
  const previousRef = useRef<{ attention: AdminAttention | null; staleItems: Readonly<Record<string, string>> }>({ attention: null, staleItems: {} });
  const activeRef = useRef(active);
  const sequenceRef = useRef(0);
  const requestRef = useRef(requestAttention);

  useEffect(() => {
    requestRef.current = requestAttention;
  }, [requestAttention]);

  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    const result = await requestRef.current().catch(() => ({ ok: false as const }));
    if (sequence !== sequenceRef.current) return;
    const previous = previousRef.current;
    if (result.ok) {
      if (previous.attention && Date.parse(result.attention.checkedAt) < Date.parse(previous.attention.checkedAt)) return;
      const missing = new Set(result.attention.unavailable);
      const retained = previous.attention?.items.filter((item) => missing.has(adminAttentionItemSource(item))) ?? [];
      const next: AdminAttention = {
        ...result.attention,
        items: [...result.attention.items.filter((item) => !missing.has(adminAttentionItemSource(item))), ...retained]
      };
      const stale = Object.fromEntries(retained.map((item) =>
        [item.id, previous.staleItems[item.id] ?? previous.attention!.checkedAt]));
      previousRef.current = { attention: next, staleItems: stale };
      setAttention(next);
      setStaleItems(stale);
      setUnavailable(false);
    } else {
      const stale = Object.fromEntries((previous.attention?.items ?? []).map((item) =>
        [item.id, previous.staleItems[item.id] ?? previous.attention!.checkedAt]));
      previousRef.current = { ...previous, staleItems: stale };
      setStaleItems(stale);
      setUnavailable(true);
    }
    setSettled(true);
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    void refresh();
  }, [active, refresh, refreshKey]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(), 25_000);
    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      // A request still in flight belongs to the surface that started it.
      sequenceRef.current += 1;
    };
  }, [active, refresh]);

  return useMemo(
    () => ({
      attention,
      loading: !settled,
      refresh,
      staleItems,
      unavailable
    }),
    [attention, refresh, settled, staleItems, unavailable]
  );
}
