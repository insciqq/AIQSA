import {
  requestAdminAttention,
  type AdminAttentionResult
} from "@/components/admin/adminAttentionApi";
import type { AdminAttention } from "@/lib/contracts/adminAttention";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminAttentionController = Readonly<{
  attention: AdminAttention | null;
  /** True only while nothing has loaded yet; later refreshes keep the list visible. */
  loading: boolean;
  refresh(): Promise<void>;
  unavailable: boolean;
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
  const sequenceRef = useRef(0);
  const requestRef = useRef(requestAttention);

  useEffect(() => {
    requestRef.current = requestAttention;
  }, [requestAttention]);

  const refresh = useCallback(async () => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    const result = await requestRef.current();
    if (sequence !== sequenceRef.current) return;
    if (result.ok) {
      setAttention(result.attention);
      setUnavailable(false);
    } else {
      setUnavailable(true);
    }
    setSettled(true);
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh, refreshKey]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
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
      unavailable
    }),
    [attention, refresh, settled, unavailable]
  );
}
