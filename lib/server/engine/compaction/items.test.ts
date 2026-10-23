import { describe, expect, it } from "vitest";
import { buildRunConversation } from "../conversation";
import { APPROVAL_PENDING_OUTPUT } from "../toolBatch";
import type { TranscriptToolResultItem } from "../transcript";
import { APPROVAL_PENDING_TEXT, engineItemRules, itemRules } from "./items";

const result = (output: string, outcome: TranscriptToolResultItem["outcome"]): TranscriptToolResultItem =>
  ({ callId: "c", id: "r", kind: "tool_result", name: "mcp_crm_create_ticket_0123456789", outcome, output });

describe("engine item rules", () => {
  it("know the engine's approval placeholder", () => {
    expect(APPROVAL_PENDING_TEXT).toBe(APPROVAL_PENDING_OUTPUT);
    const rules = itemRules(undefined);
    expect(rules.awaitingApproval(result(APPROVAL_PENDING_TEXT, "error"))).toBe(true);
    expect(rules.awaitingApproval(result("{\"id\":\"T-1\"}", "complete"))).toBe(false);
    expect(rules.awaitingApproval(result(APPROVAL_PENDING_TEXT, "complete"))).toBe(false);
  });

  it("mark the run context, keep every user message's id stable and exclude an input later runs drop", () => {
    const block = (text: string) => ({ blocks: [{ text, type: "text" }] });
    const conversation = buildRunConversation({
      continuationTurns: new Set(),
      current: { messageId: "m-3", mode: "input" },
      messages: [
        { content: block("First question"), id: "m-1", role: "user" },
        { content: block("First answer"), id: "m-2", role: "assistant" },
        { content: block("Skills index"), id: "s-1", purpose: "skill_catalog", role: "user" },
        { content: block("Second question"), id: "m-3", role: "user" }
      ],
      nativeAnswers: new Map()
    });
    const rules = engineItemRules();
    const byText = (text: string) => conversation.items.find((item) => item.kind !== "reasoning" && "text" in item && item.text === text)!;
    expect(rules.runContext(byText("Skills index"))).toBe(true);
    expect(rules.stableId(byText("Skills index"))).toBe(false);
    // The run's own input is `msg-<id>` here and in every later run.
    expect(byText("Second question").id).toBe("msg-m-3");
    expect(rules.stableId(byText("Second question"))).toBe(true);
    expect(rules.runContext(byText("First question"))).toBe(false);
    expect(rules.stableId(byText("First question"))).toBe(true);
    expect(rules.stableId(byText("First answer"))).toBe(true);
    expect(byText("First question").id).toBe("msg-m-1");
    // An approval continuation's server turn is dropped by later runs: it never starts a kept tail.
    expect(engineItemRules(conversation.currentInputId).stableId(byText("Second question"))).toBe(false);
    expect(itemRules({ stableId: () => false }).stableId(byText("First question"))).toBe(false);
  });
});
