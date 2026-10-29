import type {
  BrowserHandoffReason,
  BrowserLiveAgent,
  BrowserLiveAgentRef,
  BrowserLiveEndReason,
  BrowserLiveErrorCode,
  BrowserLiveStep
} from "@/lib/contracts/browserLive";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import type { ThreadWorkspaceActivity } from "@/lib/contracts/workspace";
import {
  isWorkspaceBrowserCommandV2,
  workspaceBrowserStepPhraseV2,
  workspaceBrowserStepsV2
} from "@/features/run-lifecycle-v2/workspaceActivityPresentation";

/**
 * Client-owned words of the live Browser panel. The server sends codes and
 * bounded facts (`lib/contracts/browserLive.ts`); every phrase lives here.
 */

export const BROWSER_HANDOFF_TOOL_NAME = "browser_handoff";

export type BrowserLiveActivityV2 = Readonly<{
  /** The answer's run used the Workspace browser or asked for a handoff: the bar shows. */
  visible: boolean;
  /** Identity of the handoff call that is waiting now, or null. */
  pendingHandoffKey: string | null;
  /** The agent's latest browser step from the activity, for the collapsed bar. */
  lastStep: string | null;
}>;

/**
 * Whether an answer's live activity involves the Workspace browser: a running
 * or finished `aiqsa-browser` command, or a `browser_handoff` call. Presentation
 * hints only; the stream's own state decides what the panel can do.
 */
export function browserLiveActivityV2(
  toolActivity: ThreadToolActivity | null,
  workspaceActivity: ThreadWorkspaceActivity | null
): BrowserLiveActivityV2 {
  let pendingHandoffKey: string | null = null;
  let handoffSeen = false;
  for (const [index, call] of (toolActivity?.calls ?? []).entries()) {
    if (call.toolName !== BROWSER_HANDOFF_TOOL_NAME) continue;
    handoffSeen = true;
    if (call.status === "running") pendingHandoffKey = `${call.round}:${index}`;
  }
  let browserUsed = false;
  let lastStep: string | null = null;
  for (const entry of workspaceActivity?.entries ?? []) {
    if (!isWorkspaceBrowserCommandV2(entry)) continue;
    browserUsed = true;
    const step = workspaceBrowserStepsV2(entry).at(-1);
    if (step) lastStep = workspaceBrowserStepPhraseV2(step);
  }
  return { visible: browserUsed || handoffSeen, pendingHandoffKey, lastStep };
}

/** A stream step in the activity rows' words (`[browser #N] action: target @ host/path`). */
export function browserLiveStepPhraseV2(step: BrowserLiveStep): string {
  const where = step.host ? `${step.host}${step.path}` : undefined;
  return workspaceBrowserStepPhraseV2({
    number: step.n,
    action: step.action,
    ...(step.target ? { target: step.target } : {}),
    ...(where ? { where } : {})
  });
}

/** The card's title: what the agent needs the person to do, in plain words. */
export function browserHandoffTitleV2(reason: BrowserHandoffReason, host: string | null): string {
  switch (reason) {
    case "sign_in": return host ? `Sign in to ${host}` : "Sign in to continue";
    case "verification_code": return "Enter the verification code";
    case "captcha": return "Complete the check on the page";
    case "consent": return "Review the consent request";
    case "user_choice": return "Make a choice on the page";
    case "other": return "The agent needs your help";
  }
}

/** Who an agent is in the panel: the main agent, or a sub-agent by its name. */
export function browserLiveAgentLabelV2(agent: Pick<BrowserLiveAgentRef, "name">): string {
  return agent.name ?? "Main agent";
}

/** What a browsing agent is doing, for the switcher: waiting for the person, driven by them, or browsing. */
export function browserLiveAgentStatusV2(agent: Pick<BrowserLiveAgent, "controller" | "waitingForUser">): string {
  if (agent.waitingForUser) return "needs you";
  return agent.controller === "user" ? "you have control" : "browsing";
}

/** One switcher option: the agent, what it is doing and the site it is on ("shop · needs you · saucedemo.com"). */
export function browserLiveAgentOptionV2(agent: BrowserLiveAgent): string {
  const host = browserLiveHostV2(agent.page?.url);
  return [browserLiveAgentLabelV2(agent), browserLiveAgentStatusV2(agent), host].filter(Boolean).join(" · ");
}

/** The count of requests behind the one shown, or null when it is the only one. */
export function browserHandoffQueueCopyV2(pending: number): string | null {
  const others = pending - 1;
  if (others <= 0) return null;
  return others === 1 ? "1 more request is waiting after this one." : `${others} more requests are waiting after this one.`;
}

/** The host of a page address for titles; null when it does not parse. */
export function browserLiveHostV2(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host ? host.replace(/^www\./u, "") : null;
  } catch {
    return null;
  }
}

/** "4:05 left" from the real expiry; never below zero. */
export function browserHandoffCountdownV2(expiresAt: string, now: number): Readonly<{ expired: boolean; label: string }> {
  const remaining = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  if (!Number.isFinite(remaining) || remaining <= 0) return { expired: true, label: "Time is up" };
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return { expired: false, label: `${minutes}:${String(seconds).padStart(2, "0")} left` };
}

export const BROWSER_SIGN_IN_NOT_REMEMBERED_V2 =
  "This chat does not save browser sign-ins, so you will need to sign in again next time.";

/** Why the live view ended, and whether it may be reopened (only after `replaced` or `error`). */
export function browserLiveEndCopyV2(reason: BrowserLiveEndReason): Readonly<{ text: string; reopen: string | null }> {
  switch (reason) {
    case "run_finished": return { text: "The answer finished, so the live view closed.", reopen: null };
    case "browser_stopped": return { text: "The browser was closed.", reopen: null };
    case "not_available": return { text: "The live view is not available for this answer.", reopen: null };
    case "replaced": return { text: "The live view opened in another tab or window.", reopen: "Watch here" };
    case "error": return { text: "The live view stopped because of an error.", reopen: "Reopen" };
  }
}

export type BrowserLiveFailureCodeV2 = BrowserLiveErrorCode | "network_error" | "unexpected_response";

export function browserLiveErrorCopyV2(code: BrowserLiveFailureCodeV2): string {
  switch (code) {
    case "browser_live_not_found": return "The live browser is no longer available.";
    case "browser_live_unavailable": return "The browser is not running right now.";
    case "browser_live_request_invalid": return "The browser could not accept that input.";
    case "browser_live_not_in_control": return "The agent has control. Take control to use the browser.";
    case "browser_live_handoff_stale": return "This request has already ended.";
    case "browser_live_rate_limited": return "Too much input at once. Wait a moment and try again.";
    case "network_error": return "Could not reach AIQSA. Check your connection and try again.";
    case "unexpected_response": return "Something went wrong. Try again.";
  }
}
