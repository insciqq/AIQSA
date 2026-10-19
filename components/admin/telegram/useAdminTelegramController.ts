"use client";

import {
  ADMIN_TELEGRAM_STALE,
  adminTelegramErrorMessage,
  adminTelegramReasonMessage,
  requestAdminTelegram,
  runAdminTelegramCommand
} from "@/components/admin/telegram/adminTelegramApi";
import { isTelegramReasonCode, type TelegramAdminState } from "@/lib/contracts/telegram";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Health facts age in seconds; a visible page reads them again this often. */
export const ADMIN_TELEGRAM_REFRESH_MS = 15_000;

export type AdminTelegramBusy = "access" | "disable" | "enable" | "test" | null;

export type AdminTelegramOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ message: string; ok: false; stale: boolean }>;

export type AdminTelegramController = Readonly<{
  actions: Readonly<{
    refresh(): Promise<void>;
    setAccess(input: Readonly<{ groupIds: readonly string[]; restricted: boolean }>): Promise<AdminTelegramOutcome>;
    setEnabled(enabled: boolean): Promise<AdminTelegramOutcome>;
    /** Asks Telegram for the bot behind the token and stores the token only when Telegram accepts it. */
    testAndSave(token: string): Promise<AdminTelegramOutcome>;
  }>;
  state: Readonly<{
    busy: AdminTelegramBusy;
    error: string | null;
    loaded: boolean;
    loading: boolean;
    telegram: TelegramAdminState | null;
  }>;
}>;

export type AdminTelegramControllerOptions = Readonly<{
  onError(message: string): void;
  onNotice(message: string): void;
}>;

function failureMessage(code: string): string {
  return isTelegramReasonCode(code) ? adminTelegramReasonMessage(code) : adminTelegramErrorMessage(code);
}

/**
 * The one owner of the Telegram page's server state: the bot state the server
 * returned last and one busy action. Every command carries the version this
 * page read; a stale version reloads the state and leaves the page's unsaved
 * input with the caller. Background reads stop while a command runs and never
 * overwrite its answer.
 */
export function useAdminTelegramController({
  onError,
  onNotice
}: AdminTelegramControllerOptions): AdminTelegramController {
  const [telegram, setTelegram] = useState<TelegramAdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<AdminTelegramBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const telegramRef = useRef<TelegramAdminState | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const replace = useCallback((next: TelegramAdminState) => {
    telegramRef.current = next;
    setTelegram(next);
  }, []);

  const read = useCallback(async () => {
    if (busyRef.current) return;
    const generation = ++generationRef.current;
    const result = await requestAdminTelegram();
    if (!mountedRef.current || generation !== generationRef.current) return;
    setLoading(false);
    setLoaded(true);
    if (result.ok) {
      setError(null);
      replace(result.data);
    } else {
      setError(adminTelegramErrorMessage(result.error));
    }
  }, [replace]);

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => { void read(); });
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void read();
    };
    const timer = window.setInterval(onVisible, ADMIN_TELEGRAM_REFRESH_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read]);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    setLoading(true);
    await read();
  }, [read]);

  const command = useCallback(async (
    kind: Exclude<AdminTelegramBusy, null>,
    build: (version: number) => Parameters<typeof runAdminTelegramCommand>[0]
  ): Promise<AdminTelegramOutcome> => {
    const current = telegramRef.current;
    if (busyRef.current || !current) return { message: "", ok: false, stale: false };
    busyRef.current = true;
    generationRef.current += 1;
    setBusy(kind);
    try {
      const result = await runAdminTelegramCommand(build(current.version));
      if (!mountedRef.current) return { message: "", ok: false, stale: false };
      generationRef.current += 1;
      if (result.ok) {
        replace(result.data);
        return { ok: true };
      }
      const stale = result.error === ADMIN_TELEGRAM_STALE;
      return { message: failureMessage(result.error), ok: false, stale };
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [replace]);

  const afterFailure = useCallback((outcome: AdminTelegramOutcome) => {
    if (!outcome.ok && outcome.stale) void read();
    return outcome;
  }, [read]);

  const actions = useMemo<AdminTelegramController["actions"]>(() => ({
    refresh,
    setAccess: async ({ groupIds, restricted }) => {
      const outcome = afterFailure(await command("access", (expectedVersion) => ({
        action: "set_access",
        expectedVersion,
        groupIds: [...groupIds],
        restricted
      })));
      if (outcome.ok) onNotice(restricted ? "Telegram is open to the selected groups." : "Telegram is open to everyone.");
      return outcome;
    },
    setEnabled: async (enabled) => {
      const outcome = afterFailure(await command(enabled ? "enable" : "disable", (expectedVersion) => ({
        action: enabled ? "enable" : "disable",
        expectedVersion
      })));
      if (outcome.ok) onNotice(enabled ? "The Telegram bot is on." : "The Telegram bot is off.");
      else if (outcome.message) onError(outcome.message);
      return outcome;
    },
    testAndSave: async (token) => afterFailure(await command("test", (expectedVersion) => ({
      action: "test_and_save",
      expectedVersion,
      token: token.trim()
    })))
  }), [afterFailure, command, onError, onNotice, refresh]);

  return useMemo(() => ({
    actions,
    state: { busy, error, loaded, loading, telegram }
  }), [actions, busy, error, loaded, loading, telegram]);
}
