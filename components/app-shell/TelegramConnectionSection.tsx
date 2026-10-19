"use client";

import { UiV2Button } from "@/components/ui-v2";
import {
  disconnectTelegram,
  loadTelegramStatus,
  requestTelegramLinkCode,
  TELEGRAM_LINK_RATE_LIMITED,
  TelegramApiError
} from "@/components/app-shell/telegramApi";
import type { TelegramLinkCodeResponse, TelegramUserStatus } from "@/lib/contracts/telegram";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often an open link step asks whether Telegram confirmed the link. */
export const TELEGRAM_LINK_POLL_MS = 3_000;
/** The longest an open link step keeps asking, whatever the link's own expiry. */
export const TELEGRAM_LINK_POLL_LIMIT_MS = 10 * 60_000;

const ACCESS_OFF_TEXT = "Telegram access is off for your account. Ask your AIQSA administrator.";
const BOT_CHANGED_TEXT = "This AIQSA now uses a different Telegram bot. Reconnect to keep chatting from Telegram.";
const LINK_EXPIRED_TEXT = "This link has expired. Create a new one.";

type LinkStep =
  | Readonly<{ kind: "requesting" }>
  | Readonly<{ deadline: number; kind: "open"; link: TelegramLinkCodeResponse }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "failed"; text: string }>;

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "ready"; status: TelegramUserStatus }>;

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at)) : null;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value));
}

function linkRequestError(error: unknown): string {
  if (error instanceof TelegramApiError) {
    if (error.code === TELEGRAM_LINK_RATE_LIMITED) return "Too many links were created. Try again in a few minutes.";
    if (error.code === "telegram_access_off") return ACCESS_OFF_TEXT;
  }
  return "A Telegram link could not be created. Try again.";
}

function connectedLabel(status: TelegramUserStatus): string {
  const since = formatDate(status.linkedAt);
  const who = status.telegramUsername ? `Connected as @${status.telegramUsername}` : "Connected";
  return since ? `${who} since ${since}` : who;
}

/** A link stays shown for the hidden-block rule: access loss never hides how to disconnect. */
function hasLink(status: TelegramUserStatus): boolean {
  return status.state !== "not_linked";
}

/**
 * Settings → Connections → Telegram (PRD O-04, D-04, D-05, D-23): connect
 * through a one-time `t.me` link, see the connected account, disconnect, or
 * reconnect after the bot changed. While the link step is open the block asks
 * the server every 3 s whether Telegram confirmed it, for at most 10 minutes
 * or until the link expires.
 */
export function TelegramConnectionSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [linkStep, setLinkStep] = useState<LinkStep | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<Readonly<{ text: string; tone: "danger" | "ok" }> | null>(null);
  const mountedRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const linkHeadingRef = useRef<HTMLHeadingElement>(null);
  const linkRequestRef = useRef<AbortController | null>(null);
  const focusAfterRender = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      linkRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const focus = focusAfterRender.current;
    focusAfterRender.current = null;
    focus?.();
  });

  const reload = useCallback((signal?: AbortSignal) => loadTelegramStatus(signal).then(
    (status) => {
      if (mountedRef.current && !signal?.aborted) setLoad({ kind: "ready", status });
    },
    () => {
      if (mountedRef.current && !signal?.aborted) setLoad((current) => current.kind === "ready" ? current : { kind: "error" });
    }
  ), []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  // The open link step polls the status until Telegram confirms, the link expires or 10 minutes pass.
  const openLink = linkStep?.kind === "open" ? linkStep : null;
  useEffect(() => {
    if (!openLink) return;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() >= openLink.deadline) {
        setLinkStep({ kind: "expired" });
        return;
      }
      inFlight = true;
      try {
        const status = await loadTelegramStatus(controller.signal);
        if (controller.signal.aborted || !mountedRef.current) return;
        setLoad({ kind: "ready", status });
        if (status.state === "linked") {
          setLinkStep(null);
          setMessage({ text: `${connectedLabel(status)}.`, tone: "ok" });
          focusAfterRender.current = () => headingRef.current?.focus();
        }
      } catch {
        // A failed read is retried on the next tick; the deadline still bounds the step.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), TELEGRAM_LINK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [openLink]);

  const startLink = async () => {
    if (linkStep?.kind === "requesting") return;
    linkRequestRef.current?.abort();
    const controller = new AbortController();
    linkRequestRef.current = controller;
    setMessage(null);
    setConfirming(false);
    setLinkStep({ kind: "requesting" });
    try {
      const link = await requestTelegramLinkCode(controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      const expiresAt = Date.parse(link.expiresAt);
      const limit = Date.now() + TELEGRAM_LINK_POLL_LIMIT_MS;
      setLinkStep({ deadline: Number.isFinite(expiresAt) ? Math.min(expiresAt, limit) : limit, kind: "open", link });
      focusAfterRender.current = () => linkHeadingRef.current?.focus();
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setLinkStep({ kind: "failed", text: linkRequestError(error) });
      if (error instanceof TelegramApiError && error.code === "telegram_access_off") void reload();
    }
  };

  const closeLink = () => {
    linkRequestRef.current?.abort();
    setLinkStep(null);
    focusAfterRender.current = () => connectRef.current?.focus();
  };

  const cancelDisconnect = () => {
    setConfirming(false);
    focusAfterRender.current = () => disconnectRef.current?.focus();
  };

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    setMessage(null);
    try {
      const status = await disconnectTelegram();
      if (!mountedRef.current) return;
      setLoad({ kind: "ready", status });
      setConfirming(false);
      setMessage({ text: "Telegram disconnected. The bot no longer answers for your account.", tone: "ok" });
      focusAfterRender.current = () => (connectRef.current ?? headingRef.current)?.focus();
    } catch {
      if (!mountedRef.current) return;
      setConfirming(false);
      setMessage({ text: "Telegram could not be disconnected. Try again.", tone: "danger" });
      focusAfterRender.current = () => disconnectRef.current?.focus();
    } finally {
      if (mountedRef.current) setDisconnecting(false);
    }
  };

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (load.kind === "ready" && !load.status.available && !hasLink(load.status)) return null;

  const status = load.kind === "ready" ? load.status : null;
  const linkOpen = linkStep !== null;
  let title: string;
  let note: Readonly<{ text: string; tone: "danger" | "warn" }> | null = null;
  if (!status) {
    title = load.kind === "error" ? "Status unavailable" : "Loading Telegram…";
    if (load.kind === "error") note = { text: "Telegram status could not be loaded. Your connection was not changed.", tone: "danger" };
  } else if (status.state === "linked") title = connectedLabel(status);
  else if (status.state === "access_off") {
    title = status.telegramUsername ? `Access off for @${status.telegramUsername}` : "Access off";
    note = { text: `${ACCESS_OFF_TEXT} Your link is kept and works again when access returns.`, tone: "warn" };
  } else if (status.state === "bot_changed") {
    title = "Reconnect needed";
    note = { text: BOT_CHANGED_TEXT, tone: "warn" };
  } else title = "Not connected";

  const canConnect = status !== null && (status.state === "not_linked" || status.state === "bot_changed") && status.available;
  const canDisconnect = status !== null && hasLink(status);

  return (
    <section aria-labelledby="telegram-connection-heading" className="v2-settings-mcp mb-6" data-testid="settings-telegram">
      <div className="v2-settings-section-heading">
        <div>
          <h3 className="v2-settings-section-title outline-none" id="telegram-connection-heading" ref={headingRef} tabIndex={-1}>
            Telegram
          </h3>
          <p className="v2-settings-section-description">
            Chat with AIQSA from Telegram: new chats, replies, files and scheduled task results.
          </p>
        </div>
      </div>
      <div className="v2-settings-row" data-testid="settings-telegram-status">
        <div className="v2-settings-row-copy">
          <span className="v2-settings-row-title" data-testid="settings-telegram-state">{title}</span>
          {note ? (
            <span className="v2-settings-field-note" data-tone={note.tone} role={note.tone === "danger" ? "alert" : undefined}>
              {note.text}
            </span>
          ) : null}
        </div>
        <div className="v2-settings-row-control flex-wrap">
          {load.kind === "error" ? (
            <UiV2Button onClick={() => { setLoad({ kind: "loading" }); void reload(); }} type="button">Retry</UiV2Button>
          ) : null}
          {canConnect && !linkOpen ? (
            <UiV2Button
              data-testid="settings-telegram-connect"
              onClick={() => void startLink()}
              ref={connectRef}
              tone="primary"
              type="button"
            >
              {status?.state === "bot_changed" ? "Reconnect" : "Connect Telegram"}
            </UiV2Button>
          ) : null}
          {canDisconnect && !confirming ? (
            <UiV2Button
              data-testid="settings-telegram-disconnect"
              disabled={disconnecting}
              onClick={() => setConfirming(true)}
              ref={disconnectRef}
              tone="destructive"
              type="button"
            >
              Disconnect
            </UiV2Button>
          ) : null}
        </div>
      </div>

      {linkStep ? (
        <div
          aria-labelledby="telegram-link-heading"
          className="v2-settings-personal-mcp-form mt-3"
          data-testid="settings-telegram-link"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeLink();
            }
          }}
          role="group"
        >
          <div>
            <h4 className="outline-none" id="telegram-link-heading" ref={linkHeadingRef} tabIndex={-1}>
              {status?.state === "bot_changed" ? "Reconnect Telegram" : "Connect Telegram"}
            </h4>
            {linkStep.kind === "open" ? (
              <p>
                Open the link in Telegram and press Start. It works once and expires at{" "}
                <time dateTime={linkStep.link.expiresAt}>{formatTime(Date.parse(linkStep.link.expiresAt))}</time>. This page
                updates when Telegram confirms.
              </p>
            ) : linkStep.kind === "requesting" ? (
              <p role="status">Creating a link…</p>
            ) : linkStep.kind === "expired" ? (
              <p role="status">{LINK_EXPIRED_TEXT}</p>
            ) : (
              <p className="v2-settings-field-note" data-tone="danger" role="alert">{linkStep.text}</p>
            )}
          </div>
          {linkStep.kind === "open" ? (
            <p className="m-0 break-all font-mono text-xs text-ink-muted select-text" data-testid="settings-telegram-deep-link">
              {linkStep.link.deepLink}
            </p>
          ) : null}
          <div className="v2-settings-personal-mcp-options flex flex-wrap gap-2">
            {linkStep.kind === "open" ? (
              <a
                className="v2-button v2-focusable"
                data-testid="settings-telegram-open"
                data-tone="primary"
                href={linkStep.link.deepLink}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span>Open Telegram</span>
              </a>
            ) : linkStep.kind === "expired" || linkStep.kind === "failed" ? (
              <UiV2Button onClick={() => void startLink()} tone="primary" type="button">Create a new link</UiV2Button>
            ) : null}
            <UiV2Button onClick={closeLink} type="button">Cancel</UiV2Button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div
          aria-labelledby="telegram-disconnect-text"
          className="v2-settings-personal-mcp-form mt-3"
          data-testid="settings-telegram-disconnect-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !disconnecting) {
              event.preventDefault();
              event.stopPropagation();
              cancelDisconnect();
            }
          }}
          role="group"
        >
          <p id="telegram-disconnect-text">
            Disconnect Telegram? The bot stops answering for your AIQSA account. Your chats stay in AIQSA, and you can
            connect again any time.
          </p>
          <div className="v2-settings-personal-mcp-options flex flex-wrap gap-2">
            <UiV2Button busy={disconnecting} onClick={() => void disconnect()} ref={confirmRef} tone="destructive" type="button">
              Disconnect
            </UiV2Button>
            <UiV2Button disabled={disconnecting} onClick={cancelDisconnect} type="button">Cancel</UiV2Button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="v2-settings-field-note mt-2" data-tone={message.tone} role={message.tone === "danger" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
