"use client";

import {
  ADMIN_DISCORD_STALE,
  adminDiscordErrorMessage,
  requestAdminDiscord,
  runAdminDiscordCommand
} from "@/components/admin/discord/adminDiscordApi";
import type { DiscordAdminCommand, DiscordAdminState, DiscordChannelMode, DiscordLimits } from "@/lib/contracts/discord";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Health facts age in seconds; a visible page reads them again this often. */
export const ADMIN_DISCORD_REFRESH_MS = 15_000;

export type AdminDiscordBusy =
  | "assistant" | "channels" | "direct_messages" | "disable" | "enable" | "guild" | "limits" | "service_account"
  | "test" | "test_access" | null;

export type AdminDiscordOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ code: string; message: string; ok: false; stale: boolean }>;

export type AdminDiscordController = Readonly<{
  actions: Readonly<{
    createServiceAccount(): Promise<AdminDiscordOutcome>;
    /** Reads the state again and clears the stale-version prompt. */
    reload(): Promise<void>;
    setAssistant(assistantId: string): Promise<AdminDiscordOutcome>;
    setChannels(input: Readonly<{ channelIds: readonly string[]; mode: DiscordChannelMode }>): Promise<AdminDiscordOutcome>;
    setDirectMessages(enabled: boolean): Promise<AdminDiscordOutcome>;
    setEnabled(enabled: boolean): Promise<AdminDiscordOutcome>;
    setGuild(guildId: string): Promise<AdminDiscordOutcome>;
    setLimits(limits: DiscordLimits): Promise<AdminDiscordOutcome>;
    setTestAccess(input: Readonly<{ testAuthorIds: readonly string[]; testChannelIds: readonly string[] }>): Promise<AdminDiscordOutcome>;
    /** Asks Discord for the bot behind the token and stores the token only when Discord accepts it. */
    testAndSave(token: string): Promise<AdminDiscordOutcome>;
  }>;
  state: Readonly<{
    busy: AdminDiscordBusy;
    discord: DiscordAdminState | null;
    error: string | null;
    loaded: boolean;
    loading: boolean;
    /** A command was refused because another administrator saved first; the page offers Reload. */
    stale: boolean;
  }>;
}>;

export type AdminDiscordControllerOptions = Readonly<{
  onError(message: string): void;
  onNotice(message: string): void;
}>;

const IDLE: AdminDiscordOutcome = { code: "", message: "", ok: false, stale: false };

/**
 * The one owner of the Discord section's bot state: the state the server
 * returned last and one busy command. Every command carries the version this
 * page read. A stale version raises the reload prompt and leaves the page's
 * unsaved input with the caller; background reads stop while a command runs
 * and never overwrite its answer.
 */
export function useAdminDiscordController({
  onError,
  onNotice
}: AdminDiscordControllerOptions): AdminDiscordController {
  const [discord, setDiscord] = useState<DiscordAdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<AdminDiscordBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const discordRef = useRef<DiscordAdminState | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const replace = useCallback((next: DiscordAdminState) => {
    discordRef.current = next;
    setDiscord(next);
  }, []);

  const read = useCallback(async () => {
    if (busyRef.current) return;
    const generation = ++generationRef.current;
    const result = await requestAdminDiscord();
    if (!mountedRef.current || generation !== generationRef.current) return;
    setLoading(false);
    setLoaded(true);
    if (result.ok) {
      setError(null);
      replace(result.data);
    } else {
      setError(adminDiscordErrorMessage(result.error));
    }
  }, [replace]);

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => { void read(); });
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void read();
    };
    const timer = window.setInterval(onVisible, ADMIN_DISCORD_REFRESH_MS);
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

  const reload = useCallback(async () => {
    if (busyRef.current) return;
    setStale(false);
    setLoading(true);
    await read();
  }, [read]);

  const command = useCallback(async (
    kind: Exclude<AdminDiscordBusy, null>,
    build: (expectedVersion: number) => DiscordAdminCommand,
    notice: string
  ): Promise<AdminDiscordOutcome> => {
    const current = discordRef.current;
    if (busyRef.current || !current) return IDLE;
    busyRef.current = true;
    generationRef.current += 1;
    setBusy(kind);
    try {
      const result = await runAdminDiscordCommand(build(current.version));
      if (!mountedRef.current) return IDLE;
      generationRef.current += 1;
      if (result.ok) {
        replace(result.data);
        setStale(false);
        onNotice(notice);
        return { ok: true };
      }
      const isStale = result.error === ADMIN_DISCORD_STALE;
      if (isStale) setStale(true);
      return { code: result.error, message: adminDiscordErrorMessage(result.error), ok: false, stale: isStale };
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [onNotice, replace]);

  const actions = useMemo<AdminDiscordController["actions"]>(() => ({
    createServiceAccount: () => command("service_account", (expectedVersion) => ({
      action: "create_service_account", expectedVersion
    }), "The Discord service account was created."),
    reload,
    setAssistant: (assistantId) => command("assistant", (expectedVersion) => ({
      action: "set_assistant", assistantId, expectedVersion
    }), "The Discord Assistant was saved."),
    setChannels: ({ channelIds, mode }) => command("channels", (expectedVersion) => ({
      action: "set_channels", channelIds: [...channelIds], channelMode: mode, expectedVersion
    }), "Discord channels were saved."),
    setDirectMessages: (dmEnabled) => command("direct_messages", (expectedVersion) => ({
      action: "set_direct_messages", dmEnabled, expectedVersion
    }), dmEnabled ? "The bot answers direct messages." : "The bot ignores direct messages."),
    setEnabled: async (enabled) => {
      const outcome = await command(enabled ? "enable" : "disable", (expectedVersion) => ({
        action: enabled ? "enable" : "disable", expectedVersion
      }), enabled ? "The Discord bot is on." : "The Discord bot is off.");
      if (!outcome.ok && outcome.message) onError(outcome.message);
      return outcome;
    },
    setGuild: (guildId) => command("guild", (expectedVersion) => ({
      action: "set_guild", expectedVersion, guildId
    }), "The Discord server was saved."),
    setLimits: (limits) => command("limits", (expectedVersion) => ({
      action: "set_limits", expectedVersion, limits
    }), "Discord limits were saved."),
    setTestAccess: ({ testAuthorIds, testChannelIds }) => command("test_access", (expectedVersion) => ({
      action: "set_test_access", expectedVersion, testAuthorIds: [...testAuthorIds], testChannelIds: [...testChannelIds]
    }), "Test mode was saved."),
    testAndSave: (token) => command("test", (expectedVersion) => ({
      action: "test_and_save", expectedVersion, token: token.trim()
    }), "The Discord bot token was saved.")
  }), [command, onError, reload]);

  return useMemo(() => ({
    actions,
    state: { busy, discord, error, loaded, loading, stale }
  }), [actions, busy, discord, error, loaded, loading, stale]);
}
