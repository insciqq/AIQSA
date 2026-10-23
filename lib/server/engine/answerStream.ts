import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { logEvent } from "../observability";

/**
 * The answer text of a native run as the user sees it: the text of every
 * model response of the turn, separated by a blank line, streamed as it
 * arrives and saved to the answer message as it grows. Saving while
 * streaming is best effort (the answer is published whole at the end), so a
 * failed write never stops the run. A response that is sent again drops what
 * its failed attempt streamed (`message_reset`, then the kept text once
 * more), and a delivered follow-up starts the answer over.
 */
export const ANSWER_SAVE_INTERVAL_MS = 400;
const SEPARATOR = "\n\n";

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
  let sentInRound = false;
  let firstOutput = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let savedText = "";

  const text = () => committed && round ? `${committed}${SEPARATOR}${round}` : committed || round;

  function save(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const current = text();
    saving = saving.then(async () => {
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

  /** Replaces what the user sees with the current text. */
  function resend(): void {
    ports.send({ data: { round: roundNumber }, type: "message_reset" });
    const current = text();
    if (current) ports.send({ data: { delta: current }, type: "token" });
    sentInRound = round.length > 0;
  }

  return {
    get text(): string {
      return text();
    },
    /** A model request starts: its text follows the turn's earlier text. */
    beginRound(): void {
      round = "";
      roundNumber += 1;
      sentInRound = false;
    },
    push(delta: string): void {
      if (!delta) return;
      const separated = !sentInRound && committed && !round ? `${SEPARATOR}${delta}` : delta;
      round += delta;
      sentInRound = true;
      ports.send({ data: { delta: separated }, type: "token" });
      if (firstOutput) {
        firstOutput = false;
        ports.onFirstOutput?.();
      }
      schedule();
    },
    /** The attempt failed and is sent again: what it streamed is dropped. */
    discardAttempt(): void {
      if (!sentInRound && !round) return;
      round = "";
      resend();
      schedule();
    },
    /** The response completed with this text; the stream is corrected if it differs. */
    completeRound(finalText: string): void {
      if (finalText !== round) {
        round = finalText;
        resend();
      }
      committed = text();
      round = "";
      sentInRound = false;
      schedule();
    },
    /** A follow-up was delivered: the answer starts over after it. */
    restart(): void {
      committed = "";
      round = "";
      sentInRound = false;
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
