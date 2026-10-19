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
 * refused rich draft switches the run to plain-text drafts.
 */

export const TELEGRAM_DRAFT_THROTTLE_MS = 1_100;
export const TELEGRAM_DRAFT_REFRESH_MS = 20_000;
const DRAFT_TEXT_MAX_LENGTH = 4_096;

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
  api: Pick<TelegramBotApi, "sendMessageDraft" | "sendRichMessageDraft">;
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

  async function send(text: string): Promise<void> {
    if (!text) {
      report(await deps.api.sendMessageDraft({ ...options, text: "" }));
      return;
    }
    if (!plain) {
      const outcome = await deps.api.sendRichMessageDraft({ ...options, rich_message: render(text) });
      if (outcome.ok || outcome.kind !== "telegram" || outcome.errorCode !== 400) {
        report(outcome);
        return;
      }
      plain = true;
    }
    const tail = plainTelegramMessage(render(text)).join("\n").slice(-DRAFT_TEXT_MAX_LENGTH);
    report(await deps.api.sendMessageDraft({ ...options, text: tail }));
  }

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function fire(): void {
    timer = null;
    if (stopped || inFlight) return;
    const text = latest;
    lastSentAt = now();
    inFlight = send(text).catch(() => undefined).finally(() => {
      inFlight = null;
      sent = text;
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
