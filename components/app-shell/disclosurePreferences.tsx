"use client";

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

const LIMIT = 500;
const validKey = (key: string) => /^(folder|project-folder|workspace):[^\u0000-\u001f]{1,240}$/u.test(key);

export function createDisclosurePreferences(accountId: string | null) {
  const storageKey = accountId ? `aiqsa:disclosures:v1:${accountId}` : null;
  let values: Record<string, boolean> | null = null;
  const listeners = new Set<() => void>();
  function read() {
    if (values) return values;
    values = {};
    if (storageKey && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed: unknown = raw && raw.length <= 150_000 ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          values = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => validKey(key) && typeof value === "boolean").slice(-LIMIT));
        }
      } catch { /* Blocked or malformed browser storage keeps safe defaults. */ }
    }
    return values;
  }
  function changed(event: StorageEvent) {
    if (event.key !== storageKey && event.key !== null) return;
    values = null;
    listeners.forEach(listener => listener());
  }
  return {
    get(key: string, fallback: boolean) { return read()[key] ?? fallback; },
    set(key: string, open: boolean) {
      if (!validKey(key) || read()[key] === open) return;
      const next = { ...read() };
      delete next[key];
      next[key] = open;
      values = Object.fromEntries(Object.entries(next).slice(-LIMIT));
      try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(values)); } catch { /* Keep this tab usable. */ }
      listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) {
      if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", changed);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", changed);
      };
    }
  };
}

const DisclosureContext = createContext<ReturnType<typeof createDisclosurePreferences> | null>(null);

export function DisclosurePreferencesProvider({ accountId, children }: Readonly<{ accountId: string; children: ReactNode }>) {
  const store = useMemo(() => createDisclosurePreferences(accountId), [accountId]);
  return <DisclosureContext.Provider value={store}>{children}</DisclosureContext.Provider>;
}

export function useDisclosurePreference(key: string | null, fallback = false) {
  const shared = useContext(DisclosureContext);
  const [local] = useState(() => createDisclosurePreferences(null));
  const store = key ? shared ?? local : local;
  const getSnapshot = useCallback(() => store.get(key ?? "workspace:local", fallback), [fallback, key, store]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const open = useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
  const setOpen = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    const nextOpen = typeof next === "function" ? next(getSnapshot()) : next;
    store.set(key ?? "workspace:local", nextOpen);
  }, [getSnapshot, key, store]);
  return [open, setOpen] as const;
}
