import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createAnswerStream } from "./answerStream";

function harness(save = vi.fn(async () => undefined)) {
  const events: ModelRunSseEvent[] = [];
  const stream = createAnswerStream({ save, send: (event) => events.push(event) });
  // What the browser shows: tokens appended, a reset clears.
  const shown = () => events.reduce((text, event) => event.type === "message_reset" ? ""
    : event.type === "token" ? text + event.data.delta : text, "");
  return { events, save, shown, stream };
}

afterEach(() => vi.useRealTimers());

describe("native answer stream", () => {
  it("streams each response's text after the turn's earlier text, as the published answer reads", () => {
    const { shown, stream } = harness();
    stream.beginRound();
    stream.push("Checking.");
    stream.completeRound("Checking.");
    stream.beginRound();
    stream.completeRound("");
    stream.beginRound();
    stream.push("Done");
    stream.push(".");
    stream.completeRound("Done.");
    expect(stream.text).toBe("Checking.\n\nDone.");
    expect(shown()).toBe(stream.text);
  });

  it("drops what a failed attempt streamed and shows the kept text again", () => {
    const { events, shown, stream } = harness();
    stream.beginRound();
    stream.push("First.");
    stream.completeRound("First.");
    stream.beginRound();
    stream.push("Partial ans");
    stream.discardAttempt();
    stream.push("Whole answer.");
    stream.completeRound("Whole answer.");
    expect(events.some((event) => event.type === "message_reset")).toBe(true);
    expect(shown()).toBe("First.\n\nWhole answer.");
  });

  it("corrects the stream when a response's final text differs from what streamed", () => {
    const { shown, stream } = harness();
    stream.beginRound();
    stream.completeRound("Not streamed at all.");
    expect(shown()).toBe("Not streamed at all.");
  });

  it("saves as it grows, and a failed save never stops the answer", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => { throw new Error("database down"); });
    const { stream } = harness(save);
    stream.beginRound();
    stream.push("Hello");
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledWith("Hello");
    stream.push(" world");
    await expect(stream.flush()).resolves.toBeUndefined();
    expect(stream.text).toBe("Hello world");
  });

  it("starts over after a delivered follow-up", () => {
    const { stream } = harness();
    stream.beginRound();
    stream.push("Old");
    stream.completeRound("Old");
    stream.restart();
    stream.beginRound();
    stream.push("New");
    stream.completeRound("New");
    expect(stream.text).toBe("New");
  });
});
