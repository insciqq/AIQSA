import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { textConversationForRequest, conversationPreview } from "../providers/context";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  insertToolHistory,
  refreshToolHistory,
  renderToolHistoryBlock,
  toolHistoryMessage,
  withoutToolHistory,
  type ToolHistoryBlock
} from "./toolHistory";
import { toolHistoryMessageId } from "./toolHistoryContract";

const message = (id: string, role: "assistant" | "user", text = id, extra: Partial<ProviderConversationMessage> = {}): ProviderConversationMessage =>
  ({ id, role, content: textMessageContent(text), ...extra });

const request = (messages: ProviderConversationMessage[]): ProviderRunRequest => ({
  attachmentIds: [], attachments: [], chatId: "chat", content: messages.at(-1)!.content,
  context: { messages, mode: "branch_path" }, knowledgePlan: { mode: "none" } as never, modelCapabilities: { nativePdfInput: false,
    nativeSearch: false, pdf: false, reasoning: false, vision: false }, modelId: "m", params: {}, prompt: { developer: null, system: null },
  provider: "fake", searchPlan: { mode: "off", options: [] } as never, toolMode: "auto"
});

const block = (turnMessageId: string, userMessageId: string | null, entries = 1): ToolHistoryBlock => ({
  turnMessageId, userMessageId, header: `[record ${turnMessageId}]`, footer: null,
  entries: Array.from({ length: entries }, (_, index) => ({ ref: `tcr1_${String(index).padStart(32, "0")}`,
    full: `- [tcr1_${String(index).padStart(32, "0")}] call ${index}: executed. Arguments: ${"a".repeat(200)}`,
    compact: `- [tcr1_${String(index).padStart(32, "0")}] call ${index}: executed.`, details: true }))
});

const ids = (value: ProviderRunRequest) => value.context!.messages.map(entry => entry.id);

describe("tool history placement", () => {
  const branch = [message("q1", "user"), message("a1", "assistant"), message("q2", "user"), message("q3", "user")];

  it("places a turn's record right before its answer and earlier attempts before the current message", () => {
    const placed = insertToolHistory(request(branch), { blocks: [block("a1", "q1"), block("q3", "q3")] });
    expect(ids(placed)).toEqual(["q1", toolHistoryMessageId("a1"), "a1", "q2", toolHistoryMessageId("q3"), "q3"]);
    const record = placed.context!.messages[1]!;
    expect(record).toMatchObject({ role: "assistant", historyClass: "tool_history", contextTurnId: toolHistoryMessageId("a1") });
    expect(record.purpose).toBeUndefined();
    // The current message stays last and remains a user message.
    expect(placed.context!.messages.at(-1)!.id).toBe("q3");
  });

  it("puts the record of an answer without text in that answer's place", () => {
    // q2's answer failed without text: it is not in the context.
    const placed = insertToolHistory(request([...branch.slice(0, 3), message("followup", "user", "more", { contextTurnId: "q2" }),
      message("q3", "user")]), { blocks: [block("a2-missing", "q2")] });
    expect(ids(placed)).toEqual(["q1", "a1", "q2", "followup", toolHistoryMessageId("a2-missing"), "q3"]);
  });

  it("replaces existing records on insert and only refreshes those still present", () => {
    const placed = insertToolHistory(request(branch), { blocks: [block("a1", "q1")] });
    const again = insertToolHistory(placed, { blocks: [block("a1", "q1", 2)] });
    expect(ids(again).filter(id => id.startsWith("tch1_"))).toHaveLength(1);
    expect(again.context!.messages[1]!.content.blocks).toHaveLength(3);
    // A record that left (covered and released) is never added back.
    const released = { ...placed, context: { ...placed.context!, messages: placed.context!.messages.filter(entry => entry.id !== toolHistoryMessageId("a1")) } };
    expect(ids(refreshToolHistory(released, { blocks: [block("a1", "q1", 2)] }))).toEqual(ids(released));
    // A present record is re-rendered from the fresh projection, or leaves.
    expect(refreshToolHistory(placed, { blocks: [block("a1", "q1", 2)] }).context!.messages[1]!.content.blocks).toHaveLength(3);
    expect(ids(refreshToolHistory(placed, { blocks: [] }))).toEqual(ids(request(branch)));
    expect(withoutToolHistory(placed.context!.messages).map(entry => entry.id)).toEqual(ids(request(branch)));
  });

  it("keeps records out of previews but in the provider conversation", () => {
    const placed = insertToolHistory(request(branch), { blocks: [block("a1", "q1")] });
    expect(textConversationForRequest(placed).map(entry => entry.id)).toContain(toolHistoryMessageId("a1"));
    expect(textConversationForRequest(placed, { redactSkillContext: true }).map(entry => entry.id)).not.toContain(toolHistoryMessageId("a1"));
    expect(conversationPreview(placed).map(entry => entry.id)).not.toContain(toolHistoryMessageId("a1"));
  });
});

describe("tool history rendering within a byte budget", () => {
  it("keeps the newest entries whole, degrades older ones and names omitted ones", () => {
    const value = block("a1", "q1", 40);
    const all = renderToolHistoryBlock(value, 1_000_000);
    expect(all.lines).toHaveLength(41);
    expect(all.detailRefs).toHaveLength(40);
    // Older entries become compact first: every call stays listed.
    const compact = renderToolHistoryBlock(value, 4096);
    expect(Buffer.byteLength(compact.lines.join("\n"))).toBeLessThanOrEqual(4096);
    expect(compact.lines.at(-1)).toContain("call 39: executed. Arguments");
    expect(compact.lines).toHaveLength(41);
    expect(compact.lines[1]).toBe(value.entries[0]!.compact);
    expect(compact.detailRefs.length).toBeLessThan(40);
    expect(compact.detailRefs).toContain(value.entries.at(-1)!.ref);
    // Below that, the oldest are counted, or named for the reader.
    const counted = renderToolHistoryBlock(value, 1500);
    expect(Buffer.byteLength(counted.lines.join("\n"))).toBeLessThanOrEqual(1500);
    expect(counted.lines[1]).toMatch(/^- \d+ earlier calls of this turn are not listed here/u);
    expect(counted.lines[1]).not.toContain("read_tool_call");
    const named = renderToolHistoryBlock(value, 1500, { nameOmittedRefs: true });
    expect(Buffer.byteLength(named.lines.join("\n"))).toBeLessThanOrEqual(1500);
    expect(named.lines[1]).toContain("read_tool_call reads them by call_ref: ");
    expect(named.lines.at(-1)).toContain("call 39: executed.");
    const tiny = renderToolHistoryBlock(value, 10);
    expect(tiny.lines[0]).toBe("[record a1]");
    expect(tiny.detailRefs).toEqual([]);
  });

  it("carries the rendered refs that disclose details", () => {
    const record = toolHistoryMessage(block("a1", "q1", 3));
    expect(record.toolHistory?.detailRefs).toHaveLength(3);
  });
});
