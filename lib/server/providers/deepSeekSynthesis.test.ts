import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { guardDeepSeekSynthesis } from "./deepSeekSynthesis";
import type { ProviderRunResult } from "./types";

const usage = { inputTokens: 3, outputTokens: 5 } as ProviderRunResult["usage"];

async function* provider(deltas: readonly string[], finalText = deltas.join("")): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  for (const delta of deltas) yield { data: { delta }, type: "token" };
  return { finalProviderResponsePreview: {}, finalText, history: [], usage };
}

async function guarded(deltas: readonly string[], finalText?: string) {
  const stream = guardDeepSeekSynthesis(provider(deltas, finalText));
  let streamed = "";
  for (let next = await stream.next(); ; next = await stream.next()) {
    if (next.done) return { result: next.value, streamed };
    if (next.value.type === "token") streamed += next.value.data.delta;
  }
}

describe("DeepSeek synthesis guard", () => {
  // Issue #56: V4 writes two fullwidth bars on each side of DSML.
  it.each([
    ["one bar", "<｜DSML｜function_calls>"],
    ["two bars", "<｜｜DSML｜｜tool_calls>"],
    ["a closing tag", "</｜｜DSML｜｜ parameter>"]
  ])("stops native tool markup with %s and flags the response", async (_name, markup) => {
    const { result, streamed } = await guarded(["Checking. ", markup, "<｜｜DSML｜｜invoke name=\"find_tools\">"]);
    expect(streamed).toBe("Checking. ");
    expect(result).toMatchObject({ finalText: "Checking. ", synthesisToolCallForbidden: true });
    expect(result.history).toBeUndefined();
  });

  it("holds a delimiter split into single characters and never streams any of it", async () => {
    const { result, streamed } = await guarded([..."<｜｜DSML｜｜tool_calls>"]);
    expect(streamed).toBe("");
    expect(result).toMatchObject({ finalText: "", synthesisToolCallForbidden: true });
  });

  it("catches markup only the final text carries", async () => {
    const { result } = await guarded([], "<｜｜DSML｜｜tool_calls>");
    expect(result).toMatchObject({ finalText: "", synthesisToolCallForbidden: true });
  });

  it("streams ordinary text that only looks like a delimiter start", async () => {
    const text = "a < b, x <｜ y, <｜DS is not it, and it ends with <";
    const { result, streamed } = await guarded([...text]);
    expect(streamed).toBe(text);
    expect(result.finalText).toBe(text);
    expect(result).not.toHaveProperty("synthesisToolCallForbidden");
  });
});
