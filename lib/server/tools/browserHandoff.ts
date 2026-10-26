import { BROWSER_HANDOFF_REASONS, BROWSER_LIVE_LIMITS, type BrowserHandoffReason } from "@/lib/contracts/browserLive";
import type { BrowserLiveRunHandle } from "../workspace/browserLive";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "./types";

export const BROWSER_HANDOFF_TOOL_NAME = "browser_handoff";

/** The longest a handoff waits for the user (`BROWSER_LIVE_LIMITS.handoffWaitSeconds`); never past the turn's tool time. */
export const BROWSER_HANDOFF_WAIT_MS = BROWSER_LIVE_LIMITS.handoffWaitSeconds * 1_000;

/** The run's stable answer where nobody can take the browser: a Telegram turn or an unattended run. */
export const BROWSER_HANDOFF_UNAVAILABLE = "browser_handoff_unavailable";

/**
 * Where the run's handoff goes: the live browser in the web chat, a Telegram turn (whose chat has no live
 * browser, so the user gets the web chat's address), or an unattended run (a scheduled task or a webhook),
 * where nobody can take over and the occurrence then fails visibly with a sign-in-again action.
 */
export type BrowserHandoffMode =
  | Readonly<{ kind: "interactive"; live: BrowserLiveRunHandle | null; toolTimeLeftMs(): number }>
  | Readonly<{ chatUrl: string; kind: "telegram" }>
  | Readonly<{ kind: "unattended" }>;

export const browserHandoffTool: RunTool = {
  capability: "workspace",
  description: "Hand the Workspace browser to the user for a step only they should take: signing in, a code sent to them " +
    "(SMS, email, an authenticator app), a CAPTCHA or bot check, a consent, or a choice that is theirs to make. Open the page " +
    "that needs them first. The chat shows the user the live browser with your message; they act in it and press Done or " +
    "Cancel, and this call returns then, or after at most 10 minutes, with the outcome and the page the browser shows. You " +
    "never see what the user typed. After `completed`, look at the page yourself (take a screenshot and view it) before you go " +
    "on. Never ask for a password in the chat, never type a password the user did not save, and never try to solve a CAPTCHA.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      message: { description: "One or two short sentences the user reads on the card, saying what to do in the browser, " +
        "for example \"Please sign in to your Amazon account and enter the SMS code, then press Done.\"",
      maxLength: BROWSER_LIVE_LIMITS.handoffMessageChars, type: "string" },
      reason: { description: "Why the user is needed.", enum: [...BROWSER_HANDOFF_REASONS], type: "string" }
    },
    required: ["reason", "message"],
    type: "object"
  },
  name: BROWSER_HANDOFF_TOOL_NAME,
  strict: true
};

/** Reasons that mean a run's sign-in to a site ran out: an unattended run cannot go on without its owner. */
const SIGN_IN_REASONS: ReadonlySet<string> = new Set<BrowserHandoffReason>(["sign_in", "verification_code", "captcha"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a stored `browser_handoff` call shows a run that needed its owner to sign in to a site (a sign-in, a code
 * or a check) where nobody could take over: its result is `browser_handoff_unavailable`. A malformed call, one
 * refused before it ran, and a consent or a choice the agent could not ask for do not count.
 */
export function browserHandoffNeededSignIn(call: Readonly<{ arguments: unknown; result: unknown }>): boolean {
  const reason = isRecord(call.arguments) ? call.arguments.reason : undefined;
  if (typeof reason !== "string" || !SIGN_IN_REASONS.has(reason)) return false;
  const content = isRecord(call.result) && Array.isArray(call.result.content) ? call.result.content as unknown[] : [];
  return content.some((part) => isRecord(part) && part.type === "json" && isRecord(part.value) &&
    part.value.error === BROWSER_HANDOFF_UNAVAILABLE);
}

const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]+/gu;

function result(call: ModelToolCall, status: "complete" | "error", value: Readonly<Record<string, unknown>>): ToolExecutionResult {
  return { callId: call.id, content: [{ type: "json", value }], name: call.name, status };
}

/** The card's message: one bounded line of the model's text. */
function cardMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return text.length <= BROWSER_LIVE_LIMITS.handoffMessageChars ? text
    : text.slice(0, BROWSER_LIVE_LIMITS.handoffMessageChars - 1).trimEnd() + "…";
}

const NEXT_STEPS: Readonly<Record<"cancelled" | "completed" | "timed_out", string>> = {
  completed: "The user pressed Done. Look at the page yourself before you go on (take a screenshot and view it); the user may " +
    "have left it anywhere. Never repeat or ask for what the user typed. A site named in signInSavedAfterAnswer keeps its sign-in " +
    "in this browser now and is saved to the user's Secrets after your answer, unless that save is skipped; it is not saved yet.",
  cancelled: "The user pressed Cancel. Do not ask for the handoff again unless the user asks; tell the user what you could not do " +
    "without it, and go on with what you can.",
  timed_out: "The user did not finish in time. Look at the page; if the step is still needed, tell the user what is waiting for " +
    "them and finish with what you have."
};

/**
 * `browser_handoff`: the call waits inside the turn until Done, Cancel or its bounded wait, never past the
 * turn's tool time; Stop and the run's deadline end it through `signal`, which the batch then treats as the
 * run stopping. The model learns only the outcome and the page, never what the user typed or saw.
 */
export async function executeBrowserHandoff(call: ModelToolCall, mode: BrowserHandoffMode, signal: AbortSignal): Promise<ToolExecutionResult> {
  const reason = call.arguments.reason;
  const message = cardMessage(call.arguments.message);
  if (typeof reason !== "string" || !(BROWSER_HANDOFF_REASONS as readonly string[]).includes(reason) || !message) {
    return result(call, "error", { error: "browser_handoff_invalid", message: `Give a reason (${BROWSER_HANDOFF_REASONS.join(", ")}) and ` +
      "a short message for the user, then call browser_handoff again." });
  }
  if (mode.kind === "telegram") {
    return result(call, "error", { chatUrl: mode.chatUrl, error: BROWSER_HANDOFF_UNAVAILABLE,
      message: "This turn came from Telegram, where the live browser cannot be shown, so nobody can take over the browser " +
        "now. Tell the user what the site needs and to continue in this chat on the web, where they can take over the browser: " +
        `${mode.chatUrl}. Do not ask for passwords or codes in the chat.` });
  }
  if (mode.kind === "unattended") {
    return result(call, "error", { error: BROWSER_HANDOFF_UNAVAILABLE,
      message: "This run is unattended (a scheduled task or a webhook), so nobody can take over the browser now. Do not try to " +
        "sign in or get around the check yourself. Finish with what you have and say that the user needs to sign in to the site " +
        "again in a chat with you (ask there to open the site; the chat shows the live browser), so later runs can use the " +
        "saved sign-in." });
  }
  const waitMs = Math.min(BROWSER_HANDOFF_WAIT_MS, Math.max(0, mode.toolTimeLeftMs()));
  if (!mode.live || waitMs < 30_000) {
    return result(call, "error", { error: BROWSER_HANDOFF_UNAVAILABLE,
      message: !mode.live
        ? "The live browser is not available in this chat, so nobody can take over the browser. Tell the user what the site " +
          "needs and finish with what you have."
        : "Too little time is left in this answer for the user to take over the browser. Tell the user what the site needs and " +
          "finish with what you have; they can ask you again to continue." });
  }
  const handoff = await mode.live.handoff({ message, reason: reason as BrowserHandoffReason, signal, waitMs });
  switch (handoff.kind) {
    case "no_browser":
      return result(call, "error", { error: "browser_handoff_no_browser", message: "No page is open in the Workspace browser. " +
        "Open the page that needs the user first (for example `aiqsa-browser open URL`), then call browser_handoff again." });
    case "busy":
      return result(call, "error", { error: "browser_handoff_busy", message: "Another handoff is already waiting for the user; " +
        "wait for its result." });
    case "unavailable":
      return result(call, "error", { error: BROWSER_HANDOFF_UNAVAILABLE, message: "The live browser cannot reach this chat's " +
        "Workspace browser now: it may not be running, or the Workspace runs an older image (a new chat uses the current one). " +
        "If you have not opened the page yet, open it and call browser_handoff once more; otherwise tell the user what the site " +
        "needs and finish with what you have." });
    case "ended":
      return result(call, "complete", {
        outcome: handoff.outcome,
        page: handoff.page,
        ...(handoff.saved ? { signInSavedAfterAnswer: handoff.saved } : {}),
        next: NEXT_STEPS[handoff.outcome]
      });
  }
}
