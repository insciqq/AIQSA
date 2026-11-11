"use client";

import { adminDiscordErrorMessage, type AdminDiscordResult } from "@/components/admin/discord/adminDiscordApi";
import { useCallback, useEffect, useRef, useState } from "react";

export type DiscordListing<T> = Readonly<{
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  /** Replaces the data with a fresher server answer, such as the key list after a revoke. */
  replace(next: T): void;
}>;

/**
 * One read-only listing (servers, channels, Assistants, keys, activity) keyed
 * by what it depends on: a null key reads nothing, and an answer for an older
 * key is dropped, so switching servers never shows the previous one's channels.
 * `load` must be stable (a module function), or every render reads again.
 */
export function useDiscordListing<T>(
  key: string | null,
  load: (key: string) => Promise<AdminDiscordResult<T>>
): DiscordListing<T> {
  const [state, setState] = useState<Readonly<{ data: T | null; error: string | null; key: string | null; loading: boolean }>>(
    { data: null, error: null, key: null, loading: false }
  );
  const generationRef = useRef(0);

  const read = useCallback((target: string | null) => {
    const generation = ++generationRef.current;
    if (target === null) {
      setState({ data: null, error: null, key: null, loading: false });
      return;
    }
    setState((current) => ({ data: current.key === target ? current.data : null, error: null, key: target, loading: true }));
    void load(target).then((result) => {
      if (generation !== generationRef.current) return;
      setState(result.ok
        ? { data: result.data, error: null, key: target, loading: false }
        : { data: null, error: adminDiscordErrorMessage(result.error), key: target, loading: false });
    });
  }, [load]);

  useEffect(() => {
    queueMicrotask(() => read(key));
    return () => {
      generationRef.current += 1;
    };
  }, [key, read]);

  const reload = useCallback(() => read(key), [key, read]);
  const replace = useCallback((next: T) => {
    generationRef.current += 1;
    setState({ data: next, error: null, key, loading: false });
  }, [key]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: key !== null && (!current || state.loading),
    reload,
    replace
  };
}
