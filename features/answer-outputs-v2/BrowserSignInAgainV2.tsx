"use client";

import { useState } from "react";
import type { BrowserHandoffOutcome } from "@/lib/contracts/browserLive";
import { browserSignInAgainOutcome, browserSignInRequestHost } from "@/lib/contracts/browserSignIn";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { TranslatableLabel } from "@/components/ui-v2/TranslatableLabel";

export type BrowserSignInAgainRow = Readonly<{ host: string; text: string }>;

function endedText(host: string, outcome: BrowserHandoffOutcome): string {
  switch (outcome) {
    case "not_answered": return `${host} waited for you to sign in.`;
    case "cancelled": return `Signing in to ${host} was cancelled.`;
    default: return `Signing in to ${host} was not finished.`;
  }
}

/**
 * The sites an answer's sign-in handoffs ended on without the user (`BROWSER_SIGN_IN_AGAIN_OUTCOMES`), one row per
 * site in the order first asked, worded by how its last handoff ended; a site whose later handoff was completed has none.
 */
export function browserSignInAgainRows(toolActivity: ThreadToolActivity | null | undefined): readonly BrowserSignInAgainRow[] {
  const last = new Map<string, BrowserHandoffOutcome>();
  for (const call of toolActivity?.calls ?? []) {
    if (call.browserHandoff) last.set(call.browserHandoff.host, call.browserHandoff.outcome);
  }
  return [...last].flatMap(([host, outcome]) => browserSignInAgainOutcome(outcome) ? [{ host, text: endedText(host, outcome) }] : []);
}

/**
 * Sign in again under a settled answer whose sign-in handoff ended without the user: it asks the agent, in this chat,
 * to open the site and hand the browser over (`lib/contracts/browserSignIn.ts`).
 */
export function BrowserSignInAgainRowsV2({ disabled, onSignIn, toolActivity }: Readonly<{
  /** Another answer runs in the chat; the send would be refused. */
  disabled: boolean;
  onSignIn: ((host: string) => Promise<void>) | undefined;
  toolActivity: ThreadToolActivity | null | undefined;
}>) {
  const [sending, setSending] = useState<string | null>(null);
  const rows = browserSignInAgainRows(toolActivity);
  if (!onSignIn || rows.length === 0) return null;
  const signIn = (host: string) => {
    setSending(host);
    void onSignIn(host).finally(() => setSending(null));
  };
  return (
    <section aria-label="Sign in again" className="v2-browser-sign-in-again">
      <ul>
        {rows.map((row) => (
          <li key={row.host}>
            <UiV2Icon name="key" />
            <p><TranslatableLabel>{row.text}</TranslatableLabel></p>
            <UiV2Button type="button" busy={sending === row.host} disabled={disabled || (sending !== null && sending !== row.host)}
              aria-label={`Sign in again to ${row.host}`} onClick={() => signIn(row.host)}>Sign in again</UiV2Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The server-written Sign in again request: a compact chip naming the site, never a speech bubble. */
export function BrowserSignInTurnV2({ anchorId, content }: Readonly<{ anchorId: string; content: string }>) {
  const host = browserSignInRequestHost(content);
  return (
    <article className="v2-conversation-turn v2-system-turn v2-browser-sign-in-turn" data-conversation-message-id={anchorId}
      data-message-id={anchorId} data-role="user" data-system-turn="browser_sign_in_request" aria-label="Sign in again">
      <span className="v2-system-turn-chip">
        <UiV2Icon name="key" />
        <span>Sign in again{host ? <>: <code>{host}</code></> : null}</span>
      </span>
    </article>
  );
}
