import { describe, expect, it } from "vitest";
import {
  memoryUserTestimonyFragments,
  memoryUserTestimonyText
} from "./userTestimony";

describe("direct-user testimony projection", () => {
  it("slices exact UTF-16 spans in authoritative ordinal order", () => {
    const first = "I want something new 🧠.";
    const second = "Please avoid true crime.";
    const raw = `User: ${first}\n\nAssistant: suggestion\n\nUser: ${second}`;
    const firstStart = raw.indexOf(first);
    const secondStart = raw.indexOf(second);
    const spans = [{
      end: firstStart + first.length,
      ordinal: 0,
      start: firstStart
    }, {
      end: secondStart + second.length,
      ordinal: 2,
      start: secondStart
    }];

    expect(memoryUserTestimonyFragments(raw, spans)).toEqual([first, second]);
    expect(memoryUserTestimonyText(raw, spans)).toBe(
      `User: ${first}\n\nUser: ${second}`
    );
  });

  it.each([
    [[]],
    [[{ end: 4, ordinal: 0, start: 4 }]],
    [[{ end: 8, ordinal: 1, start: 5 }, { end: 4, ordinal: 0, start: 1 }]],
    [[{ end: 4, ordinal: 0, start: 1 }, { end: 6, ordinal: 0, start: 4 }]],
    [[{ end: 99, ordinal: 0, start: 0 }]],
    [[{ end: 4, extra: true, ordinal: 0, start: 1 }]]
  ] as const)("rejects a malformed authority map", (spans: unknown) => {
    expect(memoryUserTestimonyFragments("abcdefgh", spans)).toBeNull();
  });
});
