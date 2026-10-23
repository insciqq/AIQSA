import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./transcript";
import { createTranscriptWriter } from "./transcriptWriter";

const text = (id: string): TranscriptItem => ({ id, kind: "assistant_text", text: id });

describe("transcript writer", () => {
  it("hands out sequences for items written elsewhere that no queued or later record takes", async () => {
    const writes: Array<readonly [number, readonly string[]]> = [];
    const writer = createTranscriptWriter({ append: async (from, items) => { writes.push([from, items.map((item) => item.id)]); },
      firstSequence: 5, runId: "run-1" });
    const queued = writer.record([text("a"), text("b")]);
    expect(writer.reserve(1)).toBe(7);
    await writer.record([text("c")]);
    await queued;
    expect(writes).toEqual([[5, ["a", "b"]], [8, ["c"]]]);
  });
});
