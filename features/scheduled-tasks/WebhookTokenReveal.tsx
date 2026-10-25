"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { UiV2Button } from "@/components/ui-v2";
import {
  decodeScheduledTaskWebhookTokenResponse,
  type ScheduledTaskWebhookTokenResponse
} from "@/lib/contracts/scheduledTasks";
import { scheduledTaskFailureMessage } from "./scheduledTaskPresentation";
import { ScheduledTaskApiError } from "./scheduledTasksApi";

/**
 * Issues a new token for the task's webhook (Get token and Rotate token are
 * this one call): the server replaces any earlier token at once and answers
 * with the only copy of the new one. Same-origin and bodyless, like Run now,
 * so the shared origin guard applies.
 */
export async function issueScheduledTaskWebhookToken(taskId: string): Promise<ScheduledTaskWebhookTokenResponse> {
  const response = await fetch(`/api/me/scheduled-tasks/${encodeURIComponent(taskId)}/webhook-token`, {
    cache: "no-store", credentials: "same-origin", method: "POST"
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    throw new ScheduledTaskApiError(code, response.status);
  }
  const issued = decodeScheduledTaskWebhookTokenResponse(body);
  if (!issued) throw new ScheduledTaskApiError(null, response.status);
  return issued;
}

/** A ready request with the token in the header, never in the URL. */
export function webhookCurlExample(url: string, token: string): string {
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    "  -H 'Content-Type: application/json' \\",
    "  -d '{\"event\": \"test\"}'"
  ].join("\n");
}

const noSubscription = () => () => undefined;

/**
 * The address a sender posts to, on this page's origin: the server's own
 * answer replaces it once a token is issued. Before hydration the path alone.
 */
export function useWebhookUrl(path: string): string {
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => null);
  return origin ? new URL(path, origin).toString() : path;
}

type Copied = "url" | "token" | "curl";

/**
 * The token a reveal shows, by task, for a reveal of the same task that
 * mounts again at once: a live answer that settles renders its cards anew
 * (the new card renders before the old one unmounts), and the token would
 * otherwise be gone moments after Get token. Page memory only, never storage:
 * held while a reveal shows it, gone `RELEASE_MS` after the last one
 * unmounts, and at once on Hide or a failed rotation.
 */
const held = new Map<string, { timer: ReturnType<typeof setTimeout> | null; value: ScheduledTaskWebhookTokenResponse }>();
const RELEASE_MS = 5_000;

function hold(taskId: string, value: ScheduledTaskWebhookTokenResponse): void {
  forget(taskId);
  held.set(taskId, { timer: null, value });
}

function release(taskId: string): void {
  const entry = held.get(taskId);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => held.delete(taskId), RELEASE_MS);
}

function forget(taskId: string): void {
  const entry = held.get(taskId);
  if (entry?.timer) clearTimeout(entry.timer);
  held.delete(taskId);
}

/**
 * A webhook's address with Get token (Rotate token once one was issued). The
 * token appears once, with Copy, the server's whole address and a ready
 * `curl` request; it lives only in page memory (this component's state and
 * the short handover above), so it is never stored, written into the chat or
 * sent anywhere, and leaves with Hide, an unmount or a reload. Used by the
 * answer's automation card and Studio.
 */
export function WebhookTokenReveal({ issued, onIssued, taskId, url }: Readonly<{
  taskId: string;
  /** The address to show before a token is issued. */
  url: string;
  /** A token was issued before: the action rotates it. */
  issued: boolean;
  /** After each new token, with its issue time; never the token. */
  onIssued?(issuedAt: string): void;
}>) {
  const headingId = useId();
  const [revealed, setRevealed] = useState<ScheduledTaskWebhookTokenResponse | null>(() => held.get(taskId)?.value ?? null);
  const [issuedHere, setIssuedHere] = useState(() => held.has(taskId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const tokenRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const shown = useRef(revealed);
  const rotates = issued || issuedHere;
  const shownUrl = revealed?.url ?? url;

  useEffect(() => {
    mounted.current = true;
    // Taken over from a reveal that unmounted meanwhile, whose release ran first.
    if (shown.current) hold(taskId, shown.current);
    return () => {
      mounted.current = false;
      release(taskId);
    };
  }, [taskId]);

  useEffect(() => {
    shown.current = revealed;
  }, [revealed]);

  useEffect(() => {
    if (revealed) tokenRef.current?.focus();
  }, [revealed]);

  async function issue() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const next = await issueScheduledTaskWebhookToken(taskId);
      if (!mounted.current) return;
      hold(taskId, next);
      setRevealed(next);
      setIssuedHere(true);
      onIssued?.(next.issuedAt);
    } catch (failure) {
      if (!mounted.current) return;
      // Whether a failed call replaced the token shown here is unknown: it is no longer shown as usable.
      forget(taskId);
      setRevealed(null);
      setError(failure instanceof ScheduledTaskApiError
        ? scheduledTaskFailureMessage(failure.code)
        : "The token could not be issued. Check your connection and try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function copy(kind: Copied, text: string) {
    try {
      await writeClipboardText(text);
      if (mounted.current) setCopied(kind);
    } catch {
      if (mounted.current) setError("Copying failed. Select the text and copy it yourself.");
    }
  }

  return (
    <div className="v2-webhook-token" data-state={revealed ? "revealed" : "idle"} role="group" aria-labelledby={headingId}>
      <p className="v2-webhook-token-heading" id={headingId}>Webhook</p>
      <div className="v2-webhook-token-row">
        <code className="v2-webhook-token-value" data-testid="webhook-url">{shownUrl}</code>
        <UiV2Button icon="copy" type="button" aria-label="Copy webhook URL" onClick={() => void copy("url", shownUrl)}>
          {copied === "url" ? "Copied" : "Copy"}
        </UiV2Button>
      </div>
      {revealed ? (
        <div className="v2-webhook-token-reveal">
          <p className="v2-webhook-token-note">
            Copy the token now: it is shown only this once. Senders put it in a header, never in the URL.
          </p>
          <div className="v2-webhook-token-row">
            <code className="v2-webhook-token-value" data-testid="webhook-token" ref={tokenRef} tabIndex={-1}>
              {revealed.token}
            </code>
            <UiV2Button icon="copy" type="button" aria-label="Copy webhook token"
              onClick={() => void copy("token", revealed.token)}>
              {copied === "token" ? "Copied" : "Copy"}
            </UiV2Button>
          </div>
          <pre className="v2-webhook-token-curl" data-testid="webhook-curl">{webhookCurlExample(revealed.url, revealed.token)}</pre>
          <p className="v2-webhook-token-note">
            GitLab: paste the URL into the webhook and the token into Secret token; GitLab sends it as X-Gitlab-Token.
          </p>
          <span className="v2-webhook-token-actions">
            <UiV2Button icon="copy" type="button" onClick={() => void copy("curl", webhookCurlExample(revealed.url, revealed.token))}>
              {copied === "curl" ? "Copied" : "Copy curl"}
            </UiV2Button>
            <UiV2Button type="button" onClick={() => { forget(taskId); setRevealed(null); setCopied(null); }}>
              Hide token
            </UiV2Button>
          </span>
        </div>
      ) : (
        <p className="v2-webhook-token-note">
          {rotates
            ? "A token was issued. Rotating replaces it at once: senders with the old one stop working."
            : "Get a token to let another system call this URL."}
        </p>
      )}
      <span className="v2-webhook-token-actions">
        <UiV2Button busy={busy} icon="key" type="button" onClick={() => void issue()}>
          {rotates ? "Rotate token" : "Get token"}
        </UiV2Button>
      </span>
      {error ? <p className="v2-webhook-token-error" role="alert">{error}</p> : null}
    </div>
  );
}
