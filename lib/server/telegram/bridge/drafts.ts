import { logEvent } from "../../observability";
import type { TelegramBotApi, TelegramInputRichMessage } from "../botApi";
import { telegramFailureCode } from "../codes";
import { plainTelegramMessage, renderTelegramAnswer } from "../render";
import type { TelegramOutcome } from "../transport";

/**
 * The streamed draft of one run (D-09): an empty draft at once (Telegram
 * shows "Thinking…"), then the answer so far as a rich draft at most every
 * 1.1 s, sent again unchanged at least every 20 s because a draft lives 30 s,
 * and back to empty when the stream resets its text. Every draft keeps one
 * `draft_id` and offers Telegram's own Stop (`can_stop`, the draft goes away
 * on Stop). One send at a time; newer text replaces text still waiting. A
 * refused rich draft switches the run to plain-text drafts. Every draft first
 * asks, after its wait, whether the chat may still receive the answer, and
 * asks again right before it leaves (after the Bot API's pacing or a 429's
 * wait, and before a plain fallback); once it may not, the draft ends for good
 * and the answer stays in AIQSA.
 */

export const TELEGRAM_DRAFT_THROTTLE_MS = 1_100;
export const TELEGRAM_DRAFT_REFRESH_MS = 20_000;
const DRAFT_TEXT_MAX_LENGTH = 4_096;

export type TelegramDraftApi = Pick<TelegramBotApi, "sendMessageDraft" | "sendRichMessageDraft">;

export type TelegramDraftStreamer = Readonly<{
  /** Sends the empty draft now. */
  start(): void;
  /** The answer text so far. */
  update(text: string): void;
  /** The text so far was replaced: the draft goes back to empty. */
  reset(): void;
  /** Ends the draft's timers and waits for a send in flight. */
  stop(): Promise<void>;
}>;

export function createTelegramDraftStreamer(deps: Readonly<{
  /**
   * The Bot API the next draft goes through, asked right before it: null once
   * the chat may no longer receive the run's answer, which ends the draft.
   */
  reach: () => Promise<TelegramDraftApi | null>;
  chatId: number;
  draftId: number;
  now?: () => number;
  throttleMs?: number;
  refreshMs?: number;
  render?: (text: string) => TelegramInputRichMessage;
}>): TelegramDraftStreamer {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? TELEGRAM_DRAFT_THROTTLE_MS;
  const refreshMs = deps.refreshMs ?? TELEGRAM_DRAFT_REFRESH_MS;
  const render = deps.render ?? ((text: string) => renderTelegramAnswer(text, { streaming: true }).messages[0]!);
  const options = { can_stop: true, chat_id: deps.chatId, draft_id: deps.draftId, keep_on_stop: false } as const;
  let latest = "";
  let sent: string | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let plain = false;

  function report(outcome: TelegramOutcome<true>): void {
    if (outcome.ok) return;
    logEvent("service_operation", {
      code: telegramFailureCode(outcome.kind, outcome.errorCode), httpStatus: outcome.status, outcome: "degraded", stage: "dispatch",
      subsystem: "telegram"
    });
  }

  /** The draft's last outcome; `unreachable` when the chat could no longer receive it. */
  async function send(api: TelegramDraftApi, text: string): Promise<TelegramOutcome<true>> {
    const sendOptions = { authorize: async () => (await deps.reach()) !== null };
    if (!text) return api.sendMessageDraft({ ...options, text: "" }, sendOptions);
    if (!plain) {
      const outcome = await api.sendRichMessageDraft({ ...options, rich_message: render(text) }, sendOptions);
      if (outcome.ok || outcome.kind !== "telegram" || outcome.errorCode !== 400) return outcome;
      plain = true;
    }
    const tail = plainTelegramMessage(render(text)).join("\n").slice(-DRAFT_TEXT_MAX_LENGTH);
    return api.sendMessageDraft({ ...options, text: tail }, sendOptions);
  }

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** One draft, only while the chat may still receive the answer. */
  async function deliver(text: string): Promise<void> {
    try {
      const api = await deps.reach();
      const outcome = api ? await send(api, text) : null;
      if (!outcome || !outcome.ok && outcome.kind === "unreachable") {
        stopped = true;
        clear();
        return;
      }
      report(outcome);
    } catch {
      // A draft whose check or send failed is skipped; the next one asks again.
    }
    sent = text;
  }

  function fire(): void {
    timer = null;
    if (stopped || inFlight) return;
    const text = latest;
    lastSentAt = now();
    inFlight = deliver(text).finally(() => {
      inFlight = null;
      schedule();
    });
  }

  function schedule(): void {
    if (stopped || inFlight) return;
    clear();
    const due = (latest === sent ? lastSentAt + refreshMs : lastSentAt + throttleMs) - now();
    timer = setTimeout(fire, Math.max(0, due));
    timer.unref?.();
  }

  return Object.freeze({
    start() {
      if (stopped || inFlight || sent !== null) return;
      clear();
      fire();
    },
    update(text: string) {
      latest = text;
      schedule();
    },
    reset() {
      latest = "";
      schedule();
    },
    async stop() {
      stopped = true;
      clear();
      await inFlight;
    }
  });
}
