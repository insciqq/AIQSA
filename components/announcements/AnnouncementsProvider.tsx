"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnnouncementRequestError, getAnnouncementUnreadCount, markAnnouncementsRead } from "./api";

type AnnouncementsState = Readonly<{
  unreadCount: number;
  refresh(): Promise<void>;
  markRead(id: string | null): Promise<void>;
}>;
const Context = createContext<AnnouncementsState | null>(null);
export const useAnnouncements = () => useContext(Context);

function AccountAnnouncements({ children }: Readonly<{ children: ReactNode }>) {
  const [unreadCount, setUnreadCount] = useState(0);
  const alive = useRef(false);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden" || read.current || mutation.current) return;
    const controller = new AbortController();
    read.current = controller;
    const version = generation.current;
    try {
      const count = await getAnnouncementUnreadCount(controller.signal);
      if (alive.current && !controller.signal.aborted && generation.current === version) setUnreadCount(count);
    } catch (error) {
      if (alive.current && !controller.signal.aborted && generation.current === version && error instanceof AnnouncementRequestError &&
        ["unauthorized", "forbidden"].includes(error.code)) setUnreadCount(0);
    } finally { if (read.current === controller) read.current = null; }
  }, []);

  const markRead = useCallback(async (id: string | null) => {
    if (mutation.current) throw new AnnouncementRequestError("announcement_read_pending");
    generation.current++;
    read.current?.abort(); read.current = null;
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const count = await markAnnouncementsRead(id, controller.signal);
      if (alive.current && !controller.signal.aborted) setUnreadCount(count);
    } finally { if (mutation.current === controller) mutation.current = null; }
  }, []);

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      alive.current = false;
      disposed = true;
      read.current?.abort(); read.current = null;
      mutation.current?.abort(); mutation.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const value = useMemo(() => ({ unreadCount, refresh, markRead }), [unreadCount, refresh, markRead]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Remounting the account owner also drops open inboxes and outstanding reads. */
export function AnnouncementsProvider({ accountId, children }: Readonly<{ accountId: string; children: ReactNode }>) {
  return <AccountAnnouncements key={accountId}>{children}</AccountAnnouncements>;
}
