import { describe, expect, it } from "vitest";
import type { ProviderHistoryItem } from "../../providers/history";
import { charTokens, handleFor } from "./compaction.testFixtures";
import { CONTEXT_TOO_LARGE, elidedResultText, fitToolResults } from "./fallback";

const result = (callId: string, output: string): ProviderHistoryItem => ({ callId, name: "run_sql", output, type: "tool_result" });

describe("lossless tool-result fallback", () => {
  const first = `${"a".repeat(3_000)} ${handleFor("first")}`;
  const second = "b".repeat(3_000);
  const third = `${"c".repeat(3_000)} ${handleFor("third")}`;
  const history: ProviderHistoryItem[] = [
    { text: "question", type: "user" },
    { arguments: "{}", callId: "c1", name: "run_sql", type: "tool_call" },
    result("c1", first),
    { arguments: "{}", callId: "c2", name: "run_sql", type: "tool_call" },
    result("c2", second),
    { arguments: "{}", callId: "c3", name: "run_sql", type: "tool_call" },
    result("c3", third)
  ];

  it("leaves a request that fits untouched", () => {
    expect(fitToolResults({ estimate: charTokens, history, limit: 10_000, tokens: 9_500 })).toEqual({
      elided: 0, history, ok: true, tokens: 9_500
    });
  });

  it("replaces the oldest results a handle still reads, skipping those without one, until the request fits", () => {
    const fitted = fitToolResults({ estimate: charTokens, history, limit: 7_000, tokens: 9_500 });
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(fitted.elided).toBe(1);
    expect(fitted.history[2]).toEqual(result("c1", elidedResultText(handleFor("first"), first)));
    expect(fitted.history.slice(3)).toEqual(history.slice(3));
    expect(fitted.tokens).toBe(9_500 - charTokens(first) + charTokens(elidedResultText(handleFor("first"), first)));
    expect(elidedResultText(handleFor("first"), first)).toContain(`read_tool_result {"handle":"${handleFor("first")}"}`);

    const both = fitToolResults({ estimate: charTokens, history, limit: 4_200, tokens: 9_500 });
    expect(both).toMatchObject({ elided: 2, ok: true });
    if (both.ok) expect(both.history[4]).toEqual(history[4]);
  });

  it("fails with a stable code when even every readable result cannot make it fit", () => {
    expect(fitToolResults({ estimate: charTokens, history, limit: 3_000, tokens: 9_500 })).toMatchObject({
      code: CONTEXT_TOO_LARGE, elided: 2, ok: false
    });
    expect(fitToolResults({ estimate: charTokens, handleOf: () => null, history, limit: 9_000, tokens: 9_500 }))
      .toMatchObject({ code: CONTEXT_TOO_LARGE, elided: 0, ok: false, tokens: 9_500 });
  });
});
