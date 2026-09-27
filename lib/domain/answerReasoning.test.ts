import { describe, expect, it } from "vitest";
import { THREAD_REASONING_MAX_ENTRIES } from "../contracts/chats";
import {
  createReasoningFragmentBuffer,
  foldReasoningEntries,
  storedReasoningFoldItem,
  streamedReasoningFoldItem,
  type ReasoningFoldItem
} from "./answerReasoning";

const legacy = (text: string): ReasoningFoldItem => ({ kind: "legacy", text });

describe("answer reasoning records", () => {
  it("releases exact fragments that never split a UTF-16 pair and skip blank edges", () => {
    const buffer = createReasoningFragmentBuffer(4);
    const records = [
      ...buffer.append("  "),
      ...buffer.append("  "),
      ...buffer.append("ab😀"),
      ...buffer.append("c"),
      ...buffer.append("d   "),
      ...buffer.append("   "),
      ...buffer.append("ef \n"),
      ...buffer.append(" "),
      ...buffer.finish()
    ];
    expect(records).toEqual([
      { entry: "start", text: "ab😀" },
      { entry: "continue", text: "cd  " },
      { entry: "continue", text: "    " },
      { entry: "continue", text: "ef \n" }
    ]);
    const pair = createReasoningFragmentBuffer(4);
    expect([...pair.append("xab😀yz"), ...pair.finish()]).toEqual([
      { entry: "start", text: "xab" },
      { entry: "continue", text: "😀yz" }
    ]);
    expect(createReasoningFragmentBuffer().finish()).toEqual([]);
  });

  it("rejoins adjacent pre-merge rows by the legacy rule and keeps blocks apart", () => {
    const folded = foldReasoningEntries([
      legacy("Let me"),
      legacy("check this."),
      legacy("## Plan"),
      legacy("- first"),
      legacy("**Summary**"),
      legacy("x > 5 holds"),
      { kind: "other" },
      legacy("Next block"),
      streamedReasoningFoldItem({ entry: "start", text: "New " }),
      streamedReasoningFoldItem({ entry: "continue", text: "entry." })
    ]);
    expect(folded).toEqual({
      entries: [
        "Let me check this.\n\n## Plan\n\n- first\n\n**Summary** x > 5 holds",
        "Next block",
        "New entry."
      ],
      truncated: false
    });
  });

  it("tells stored pre-merge rows from records and never reads opaque parts", () => {
    expect(storedReasoningFoldItem({ text: " Legacy " })).toEqual({ kind: "legacy", text: "Legacy" });
    expect(storedReasoningFoldItem({ entry: "continue", text: " exact " }))
      .toEqual({ kind: "record", record: { entry: "continue", text: " exact " } });
    expect(storedReasoningFoldItem({ entry: "start", text: 1 })).toEqual({ kind: "other" });
    expect(storedReasoningFoldItem({ encrypted_content: "PRIVATE", id: "rs_1" })).toEqual({ kind: "other" });
  });

  it("joins surplus entries instead of dropping them and marks only cut text", () => {
    const entries = Array.from({ length: THREAD_REASONING_MAX_ENTRIES + 5 }, (_, index) =>
      streamedReasoningFoldItem({ entry: "start", text: `Item ${index}` }));
    const folded = foldReasoningEntries(entries);
    expect(folded.entries).toHaveLength(THREAD_REASONING_MAX_ENTRIES);
    expect(folded.entries.at(-1)).toContain(`Item ${THREAD_REASONING_MAX_ENTRIES + 4}`);
    expect(folded.truncated).toBe(false);
    expect(foldReasoningEntries([
      streamedReasoningFoldItem({ entry: "start", text: "Cut by the provider bound", truncated: true })
    ]).truncated).toBe(true);
  });
});
