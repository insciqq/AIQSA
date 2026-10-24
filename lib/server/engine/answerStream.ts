import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { logEvent } from "../observability";

/**
 * The answer text of a native run as the user sees it: the text of every
 * model response of the turn, separated by a blank line, streamed as it
 * arrives and saved to the answer message as it grows. Saving while
 * streaming is best effort (the answer is published whole at the end), so a
 * failed write never stops the run. A response that is sent again drops what
 * its failed attempt streamed (`message_reset`, then the kept text once
 * more), and a delivered follow-up starts the answer over. A secret value
 * the turn saved is masked in what the user sees and in what is saved
 * (`mask`, issue #52): a streamed tail that may still become one waits for
 * the next text.
 */
export const ANSWER_SAVE_INTERVAL_MS = 400;
const SEPARATOR = "\n\n";
export const MASKED_SECRET = "•••";
/** Values shorter than this are left alone: masking them would hide ordinary words. */
export const MASKED_SECRET_MIN_CHARS = 6;
/** Longer values (a whole file) are not echoed verbatim in practice, and checking them would slow every token. */
export const MASKED_SECRET_MAX_CHARS = 4_096;

export type AnswerStreamPorts = Readonly<{
  /** The first text of the answer reached the user. */
  onFirstOutput?(): void;
  /** Saves the answer text so far (`appendAssistantText`). */
  save(text: string): Promise<void>;
  send(event: ModelRunSseEvent): void;
}>;

export type AnswerStream = ReturnType<typeof createAnswerStream>;

export function createAnswerStream(ports: AnswerStreamPorts) {
  let committed = "";
  let round = "";
  let roundNumber = 0;
  /** What of this round's text the user has been sent, masked. */
  let sentRound = "";
  let firstOutput = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let savedText = "";
  /** Secret values to mask, longest first. */
  let secrets: string[] = [];

  const masked = (value: string) => secrets.reduce((current, secret) => current.replaceAll(secret, MASKED_SECRET), value);
  /** The masked text without a tail that may still become a secret value. */
  const settled = (value: string): string => {
    const current = masked(value);
    let held = 0;
    for (const secret of secrets) {
      for (let start = Math.max(0, current.length - secret.length + 1); start < current.length - held; start += 1) {
        if (current[start] === secret[0] && secret.startsWith(current.slice(start))) {
          held = current.length - start;
          break;
        }
      }
    }
    return current.slice(0, current.length - held);
  };
  const join = (before: string, after: string) => before && after ? `${before}${SEPARATOR}${after}` : before || after;
  /** What is saved: a tail that may still become a secret is not saved either. */
  const text = () => join(masked(committed), settled(round));

  function save(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // The text is read when the write runs, not when it was queued: slow writes then skip the stale texts
    // between them instead of falling further behind what the user sees (issue #53).
    saving = saving.then(async () => {
      const current = text();
      if (current === savedText) return;
      try {
        await ports.save(current);
        savedText = current;
      } catch (error) {
        // The whole answer is published at the end; a lost intermediate save only delays a reload's view.
        logEvent("service_operation", { action: "degrade", code: "answer_text_unsaved", error, outcome: "degraded",
          stage: "write", subsystem: "database" });
      }
    });
    return saving;
  }

  function schedule(): void {
    if (!timer) timer = setTimeout(() => void save(), ANSWER_SAVE_INTERVAL_MS);
  }

  /** Replaces what the user sees with the current text; a round still streaming keeps its unsettled tail back. */
  function resend(final: boolean): void {
    ports.send({ data: { round: roundNumber }, type: "message_reset" });
    sentRound = final ? masked(round) : settled(round);
    const current = join(masked(committed), sentRound);
    if (current) ports.send({ data: { delta: current }, type: "token" });
  }

  /** Sends the round's settled text beyond what was sent. */
  function sendRound(next: string): void {
    if (!next.startsWith(sentRound)) {
      resend(false);
      return;
    }
    const delta = next.slice(sentRound.length);
    if (!delta) return;
    ports.send({ data: { delta: !sentRound && committed ? `${SEPARATOR}${delta}` : delta }, type: "token" });
    sentRound = next;
  }

  return {
    get text(): string {
      return text();
    },
    /** A model request starts: its text follows the turn's earlier text. */
    beginRound(): void {
      round = "";
      roundNumber += 1;
      sentRound = "";
    },
    push(delta: string): void {
      if (!delta) return;
      round += delta;
      sendRound(settled(round));
      if (firstOutput) {
        firstOutput = false;
        ports.onFirstOutput?.();
      }
      schedule();
    },
    /** The attempt failed and is sent again: what it streamed is dropped. */
    discardAttempt(): void {
      if (!sentRound && !round) return;
      round = "";
      resend(false);
      schedule();
    },
    /** The response completed with this text; the stream is corrected if it differs. */
    completeRound(finalText: string): void {
      if (finalText !== round) {
        round = finalText;
        resend(true);
      } else {
        sendRound(masked(round));
      }
      committed = join(committed, round);
      round = "";
      sentRound = "";
      schedule();
    },
    /**
     * Values a tool of this turn saved as the user's secrets: the answer never
     * shows or saves them, and text already sent is corrected.
     */
    mask(values: readonly string[]): void {
      const added = values.filter((value) => value.length >= MASKED_SECRET_MIN_CHARS && value.length <= MASKED_SECRET_MAX_CHARS &&
        !secrets.includes(value));
      if (added.length === 0) return;
      const before = text();
      secrets = [...secrets, ...added].sort((left, right) => right.length - left.length);
      if (text() !== before) {
        resend(false);
        schedule();
      }
    },
    /** A follow-up was delivered: the answer starts over after it. */
    restart(): void {
      committed = "";
      round = "";
      sentRound = "";
      savedText = "";
    },
    flush(): Promise<void> {
      return save();
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
