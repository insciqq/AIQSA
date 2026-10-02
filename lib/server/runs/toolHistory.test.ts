import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { textConversationForRequest, conversationPreview } from "../providers/context";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  fitCurrentTurnToolHistory,
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

  it("places the current message's record before the pins that precede it, whichever came first", () => {
    const pin = message("evidence", "user", "pinned evidence", { purpose: "knowledge_evidence" });
    const pinned = [message("q1", "user"), message("a1", "assistant"), pin, message("q2", "user")];
    const expected = ["q1", "a1", toolHistoryMessageId("q2"), "evidence", "q2"];
    expect(ids(insertToolHistory(request(pinned), { blocks: [block("q2", "q2")] }))).toEqual(expected);
    // Pinned after the record was placed (the live order), the order is the same.
    const placed = insertToolHistory(request([message("q1", "user"), message("a1", "assistant"), message("q2", "user")]),
      { blocks: [block("q2", "q2")] });
    const messages = placed.context!.messages;
    expect([...messages.slice(0, -1), pin, messages.at(-1)!].map(entry => entry.id)).toEqual(expected);
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

describe("fitting the current message's record", () => {
  const estimate = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / 4);
  /** Forty calls of earlier attempts: every fourth one executed, the others refused before dispatch. */
  const mixed = (): ToolHistoryBlock => {
    const value = block("q2", "q2", 40);
    return { ...value, entries: value.entries.map((entry, index) => index % 4 === 0 ? { ...entry, essential: true } : {
      ...entry, essential: false, compact: entry.compact.replace("executed.", "not executed."),
      full: entry.full.replace("executed.", "not executed.") }) };
  };
  const withRecord = (value: ToolHistoryBlock) => insertToolHistory(request([message("q1", "user"), message("a1", "assistant"),
    message("q2", "user")]), { blocks: [value] });
  const record = (value: ProviderRunRequest) => value.context!.messages.find(entry => entry.id === toolHistoryMessageId("q2"))!;
  const text = (value: ProviderRunRequest) => record(value).content.blocks.map(entry => (entry as { text: string }).text);
  const floorTokens = (value: ToolHistoryBlock) => estimate(toolHistoryMessage(value, 0, { keepEssential: true, nameOmittedRefs: true }).content);

  it("renders it smaller by the excess: details first, then the calls that were not executed, named", () => {
    const original = withRecord(mixed());
    const before = estimate(record(original).content);
    const fitted = fitCurrentTurnToolHistory(original, 500, estimate)!;
    const after = estimate(record(fitted.request).content);
    expect(after).toBeLessThanOrEqual(before - 500);
    expect(fitted.releasedTokens).toBe(before - after);
    // Older entries become compact first, the newest keep their details.
    expect(text(fitted.request).find(line => line.includes("call 0:"))).toBe("- [tcr1_00000000000000000000000000000000] call 0: executed.");
    expect(text(fitted.request).at(-1)).toContain("call 39: not executed. Arguments");
    // A larger excess counts calls that were not executed and names their call_refs.
    const counted = fitCurrentTurnToolHistory(original, before - floorTokens(mixed()) - 40, estimate)!;
    const lines = text(counted.request);
    expect(lines[1]).toMatch(/^- \d+ calls of this turn that were not executed are not listed here \(record size limit\)\. read_tool_call reads them by call_ref: tcr1_/u);
    for (const entry of mixed().entries.filter(value => value.essential)) expect(lines).toContain(entry.compact);
    // Only that record changes; its id and place stay.
    expect(ids(fitted.request)).toEqual(ids(original));
  });

  it("never goes below the compact line of every executed call: beyond that it reports that it cannot shrink", () => {
    const value = mixed();
    const original = withRecord(value);
    const before = estimate(record(original).content);
    const minimal = fitCurrentTurnToolHistory(original, before - floorTokens(value), estimate)!;
    const lines = text(minimal.request);
    expect(lines[0]).toBe("[record q2]");
    expect(lines[1]).toBe("- 30 calls of this turn that were not executed are not listed here (record size limit).");
    expect(lines.slice(2)).toEqual(value.entries.filter(entry => entry.essential).map(entry => entry.compact));
    expect(fitCurrentTurnToolHistory(minimal.request, 1, estimate)).toBeNull();
    expect(fitCurrentTurnToolHistory(original, before - floorTokens(value) + 1, estimate)).toBeNull();
    // Calls of unknown essentiality count as executed: none of them leaves the listing.
    const executed = withRecord(block("q2", "q2", 40));
    const kept = fitCurrentTurnToolHistory(executed, 1_000_000, estimate);
    expect(kept).toBeNull();
    const compact = fitCurrentTurnToolHistory(executed, estimate(record(executed).content) - floorTokens(block("q2", "q2", 40)), estimate)!;
    expect(text(compact.request).slice(1)).toEqual(block("q2", "q2", 40).entries.map(entry => entry.compact));
    expect(fitCurrentTurnToolHistory(request([message("q1", "user")]), 100, estimate)).toBeNull();
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

  it("lists every executed call of the current message's record even beyond the normal bound", () => {
    // More compact lines than one record's normal bound holds.
    const many = block("q2", "q2", 600);
    const lines = (value: ProviderRunRequest, id: string) => value.context!.messages.find(entry => entry.id === toolHistoryMessageId(id))!
      .content.blocks.map(entry => (entry as { text: string }).text);
    const current = insertToolHistory(request([message("q1", "user"), message("a1", "assistant"), message("q2", "user")]),
      { blocks: [many] });
    expect(lines(current, "q2").slice(1)).toEqual(expect.arrayContaining(many.entries.map(entry => entry.compact)));
    expect(lines(refreshToolHistory(current, { blocks: [many] }), "q2")).toEqual(lines(current, "q2"));
    // An earlier turn's record keeps its bound: older entries are counted.
    const earlier = insertToolHistory(request([message("q1", "user"), message("a1", "assistant"), message("q2", "user")]),
      { blocks: [{ ...many, turnMessageId: "a1", userMessageId: "q1" }] });
    expect(lines(earlier, "a1")[1]).toMatch(/^- \d+ earlier calls of this turn are not listed here/u);
  });

  it("carries the rendered refs that disclose details", () => {
    const record = toolHistoryMessage(block("a1", "q1", 3));
    expect(record.toolHistory?.detailRefs).toHaveLength(3);
  });
});
