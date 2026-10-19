"use client";

import {
  ADMIN_TELEGRAM_NOT_FOUND,
  adminTelegramErrorMessage,
  requestAdminUserTelegram,
  unlinkAdminUserTelegram
} from "@/components/admin/telegram/adminTelegramApi";
import { sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { UiV2Button } from "@/components/ui-v2";
import type { TelegramAdminUserLink } from "@/lib/contracts/telegram";
import { useCallback, useEffect, useRef, useState } from "react";

const helpClass = "text-xs leading-5 text-ink-muted";

const NOT_LINKED: TelegramAdminUserLink = { state: "not_linked" };

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at)) : null;
}

function linkStateLabel(link: TelegramAdminUserLink): string {
  if (link.state === "access_off") return "Connected · Telegram access is off for this user";
  if (link.state === "bot_changed") return "Connected to a previous bot · the user needs to reconnect";
  return "Connected";
}

/**
 * The Telegram panel of one user's page (PRD D-06, D-23): link status,
 * username, linked date and Unlink after a confirmation. It loads itself; a
 * missing or invisible user reads as not connected.
 */
export function AdminUserTelegram({ userId }: Readonly<{ userId: string }>) {
  const [link, setLink] = useState<TelegramAdminUserLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof requestAdminUserTelegram>>) => {
    if (result.ok) {
      setLink(result.data);
      setError(null);
    } else if (result.error === ADMIN_TELEGRAM_NOT_FOUND) {
      setLink(NOT_LINKED);
      setError(null);
    } else {
      setError(adminTelegramErrorMessage(result.error));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++generationRef.current;
    void requestAdminUserTelegram(userId).then((result) => {
      if (mountedRef.current && generation === generationRef.current) apply(result);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [apply, userId]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const cancel = () => {
    setConfirming(false);
    window.setTimeout(() => unlinkRef.current?.focus(), 0);
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const generation = ++generationRef.current;
    const result = await unlinkAdminUserTelegram(userId);
    if (!mountedRef.current || generation !== generationRef.current) return;
    setBusy(false);
    setConfirming(false);
    if (result.ok || result.error === ADMIN_TELEGRAM_NOT_FOUND) {
      setLink(result.ok ? result.data : NOT_LINKED);
      setNotice("Telegram unlinked. The bot no longer answers for this account.");
      window.setTimeout(() => headingRef.current?.focus(), 0);
      return;
    }
    setError(adminTelegramErrorMessage(result.error));
    window.setTimeout(() => unlinkRef.current?.focus(), 0);
  };

  const linked = link !== null && link.state !== "not_linked";
  const since = formatDate(link?.linkedAt);
  const lastSeen = formatDate(link?.lastSeenAt);

  return (
    <section
      aria-labelledby="admin-user-telegram-heading"
      className="flex flex-col gap-3 border-t border-trace-subtle pt-5"
      data-testid="admin-user-telegram"
    >
      <h3 className={`${sectionHeadingClass} outline-none`} id="admin-user-telegram-heading" ref={headingRef} tabIndex={-1}>
        Telegram
      </h3>
      {link === null ? (
        <p className={helpClass} role={error ? "alert" : "status"}>{error ?? "Loading Telegram link…"}</p>
      ) : linked ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]" data-testid="admin-user-telegram-account">
                {link.telegramUsername ? `@${link.telegramUsername}` : link.displayName ?? "Telegram account"}
                {link.telegramUsername && link.displayName ? <span className="font-normal text-ink-secondary"> · {link.displayName}</span> : null}
              </p>
              <p className={helpClass} data-testid="admin-user-telegram-status">
                {linkStateLabel(link)}
                {since ? ` · since ${since}` : ""}
                {lastSeen ? ` · last message ${lastSeen}` : ""}
              </p>
            </div>
            {!confirming ? (
              <UiV2Button disabled={busy} onClick={() => setConfirming(true)} ref={unlinkRef} tone="ghost" type="button">
                Unlink
              </UiV2Button>
            ) : null}
          </div>
          {confirming ? (
            <div
              aria-labelledby="admin-user-telegram-confirm-text"
              className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-caution/25 bg-caution/5 px-3 py-2.5"
              data-testid="admin-user-telegram-unlink-confirm"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.stopPropagation();
                  cancel();
                }
              }}
              role="group"
            >
              <p className="text-xs leading-5 text-ink-secondary" id="admin-user-telegram-confirm-text">
                The bot stops answering for this account. The user&apos;s chats stay in AIQSA, and they can connect Telegram
                again from Settings.
              </p>
              <div className="flex flex-wrap gap-2">
                <UiV2Button busy={busy} onClick={() => void unlink()} ref={confirmRef} tone="destructive" type="button">
                  Unlink Telegram
                </UiV2Button>
                <UiV2Button disabled={busy} onClick={cancel} tone="ghost" type="button">
                  Cancel
                </UiV2Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className={helpClass} data-testid="admin-user-telegram-empty">No Telegram account connected.</p>
      )}
      {notice && !linked ? <p className="text-xs leading-5 text-positive" role="status">{notice}</p> : null}
      {link !== null && error ? <p className="text-xs leading-5 text-critical" role="alert">{error}</p> : null}
    </section>
  );
}
