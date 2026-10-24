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

  // Issue #52: a value the turn saved as a secret is never shown or saved in the answer, even split across tokens.
  it("masks a saved secret value in what it streams and saves", () => {
    const { events, shown, stream } = harness();
    stream.beginRound();
    stream.push("Saving it.");
    stream.completeRound("Saving it.");
    stream.mask(["abc-123-not-real", "short"]);
    stream.beginRound();
    for (const delta of ["Done: DEMO_TOKEN = ", "abc-", "123", "-not", "-re"]) stream.push(delta);
    expect(shown()).toBe("Saving it.\n\nDone: DEMO_TOKEN = ");
    expect(stream.text).toBe("Saving it.\n\nDone: DEMO_TOKEN = ");
    stream.push("al. A short note, abc-1 stays.");
    stream.completeRound("Done: DEMO_TOKEN = abc-123-not-real. A short note, abc-1 stays.");
    expect(stream.text).toBe("Saving it.\n\nDone: DEMO_TOKEN = •••. A short note, abc-1 stays.");
    expect(shown()).toBe(stream.text);
    expect(events.some((event) => event.type === "message_reset")).toBe(false);
  });

  it("corrects text already sent when a value is masked after it", () => {
    const { shown, stream } = harness();
    stream.beginRound();
    stream.push("Your token abc-123-not-real is noted.");
    stream.completeRound("Your token abc-123-not-real is noted.");
    stream.mask(["abc-123-not-real"]);
    expect(shown()).toBe("Your token ••• is noted.");
    expect(stream.text).toBe(shown());
  });

  // Issue #53: what a hard crash keeps is what was saved; slow writes must not fall behind the stream.
  it("keeps saving the latest text when writes are slower than the save interval", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_text: string) => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
    const { stream } = harness(save as never);
    stream.beginRound();
    for (let line = 1; line <= 40; line += 1) {
      stream.push(`${line}. item\n`);
      await vi.advanceTimersByTimeAsync(200);
    }
    // 8 s of streaming against 1 s writes: the write that just ran carried the text of at most one write ago.
    const saved = save.mock.calls.at(-1)![0];
    expect(stream.text.length - saved.length).toBeLessThanOrEqual("10. item\n".length * 8);
    expect(save.mock.calls.length).toBeLessThanOrEqual(9);
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
