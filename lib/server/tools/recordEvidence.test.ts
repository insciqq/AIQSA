import { describe, expect, it, vi } from "vitest";
import {
  decodeResearchRecord,
  RECORD_EVIDENCE_TOOL_NAME,
  RESEARCH_RECORD_KINDS,
  RESEARCH_SOURCE_CLASSES,
  RESEARCH_STANDINGS,
  type ResearchEvidenceRecord
} from "../../contracts/research";
import { SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import { subagentOffersTool } from "../engine/subagents/registry";
import type { EngineToolExecution } from "../engine/toolRegistry";
import { recordEvidenceEngineTool, recordEvidenceTool, type RecordEvidenceTarget } from "./recordEvidence";
import type { ToolExecutionResult } from "./types";

const NONE = { claim: null, criterion_key: null, dataset: null, quote: null, reason: null, row_key: null, source_class: null, standing: null, supersedes: null, target: null, url: null };
const FINDING = { ...NONE, claim: "The X1 holds up.", kind: "finding", quote: "held up after 10 years", source_class: "independent_tests", standing: "confirmed", url: "https://lab.example/x1" };
const RECORD_ID = "0b6f4a2e-7d1c-4c3b-9a55-1f2e3d4c5b6a";

const stored = (quoteCheck: ResearchEvidenceRecord["quoteCheck"]) => ({ id: RECORD_ID, quoteCheck }) as ResearchEvidenceRecord;

const properties = recordEvidenceTool.inputSchema.properties as Record<string, Record<string, unknown>>;

function targetOf(written: Awaited<ReturnType<RecordEvidenceTarget["evidence"]["record"]>> = { kind: "recorded", record: stored({ reason: null, status: "found" }) }, researching = true) {
  const record = vi.fn(async () => written);
  return { record, target: { evidence: { record }, researching: () => researching } satisfies RecordEvidenceTarget };
}

const signal = new AbortController().signal;

const call = (args: Record<string, unknown>): EngineToolExecution =>
  ({ call: { arguments: args, id: "call-1", name: RECORD_EVIDENCE_TOOL_NAME }, ordinal: 0, persistedToolCallId: "row-1", round: 1, signal });

const value = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("the record_evidence schema", () => {
  it("lists every field as required, and the decoder accepts what it describes for each kind", () => {
    expect([...recordEvidenceTool.inputSchema.required as string[]].sort()).toEqual(Object.keys(properties).sort());
    expect(recordEvidenceTool.strict).toBe(false);
    expect(decodeResearchRecord(FINDING)).toMatchObject({ ok: true, value: { kind: "finding" } });
    expect(decodeResearchRecord({ ...NONE, criterion_key: "firmness", kind: "not_found", reason: "Nowhere.", row_key: "x1" })).toMatchObject({ ok: true, value: { kind: "not_found" } });
    expect(decodeResearchRecord({ ...NONE, kind: "unreachable", reason: "It asks to sign in.", target: "shop.example" })).toMatchObject({ ok: true, value: { kind: "unreachable" } });
    expect(decodeResearchRecord({ ...FINDING, dataset: { counts: [{ count: 3, label: "sagging" }], examples: [{ quote: "It sagged.", url: "https://shop.example/x1" }], left_out: "Other sizes.",
      method: "Read every review.", sample_size: 120 }, kind: "dataset", quote: null, row_key: "x1" })).toMatchObject({ ok: true, value: { kind: "dataset" } });
    for (const field of Object.keys(properties)) {
      const rest = Object.fromEntries(Object.entries(FINDING).filter(([key]) => key !== field));
      expect(decodeResearchRecord(rest)).toMatchObject({ message: expect.stringContaining(field), ok: false });
    }
  });

  it("offers exactly the contract's lists, and writes a nullable object as anyOf", () => {
    expect(properties.kind!.enum).toEqual([...RESEARCH_RECORD_KINDS]);
    const options = (field: string) => properties[field]!.anyOf as Record<string, unknown>[];
    expect(options("source_class")[0]!.enum).toEqual([...RESEARCH_SOURCE_CLASSES]);
    expect(options("standing")[0]!.enum).toEqual([...RESEARCH_STANDINGS]);
    expect(options("dataset")).toEqual([expect.objectContaining({ type: "object" }), { type: "null" }]);
    expect(properties.supersedes!.type).toEqual(["string", "null"]);
  });

  it("is a researcher's tool and never a gate's: a list of tool groups never reaches it", () => {
    expect(subagentOffersTool(recordEvidenceTool, null)).toBe(true);
    expect(subagentOffersTool(recordEvidenceTool, [])).toBe(false);
    expect(subagentOffersTool(recordEvidenceTool, [SUBAGENT_TOOL_GROUPS.web_fetch])).toBe(false);
  });
});

describe("a record_evidence call", () => {
  it("writes under the agent its registry names, whatever the model says", async () => {
    const { record, target } = targetOf();
    await recordEvidenceEngineTool(target, { kind: "subagent", name: "lab", threadId: "thread-1" }).execute(call({ ...FINDING, author: { name: "someone", threadId: "thread-9" } }));
    expect(record).toHaveBeenCalledWith({ author: { name: "lab", threadId: "thread-1" }, record: expect.objectContaining({ claim: FINDING.claim, kind: "finding" }) }, signal);
    await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
    expect(record).toHaveBeenLastCalledWith({ author: { name: null, threadId: null }, record: expect.anything() }, signal);
    await recordEvidenceEngineTool(target, undefined).execute(call(FINDING));
    expect(record).toHaveBeenLastCalledWith({ author: { name: null, threadId: null }, record: expect.anything() }, signal);
  });

  it("is refused until research started, with nothing written", async () => {
    const { record, target } = targetOf(undefined, false);
    const result = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
    expect(result.status).toBe("error");
    expect(value(result)).toMatchObject({ code: "research_not_started", message: expect.stringContaining("start_research") });
    expect(record).not.toHaveBeenCalled();
  });

  it("names the field to correct, with nothing written", async () => {
    const { record, target } = targetOf();
    const result = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call({ ...FINDING, quote: null }));
    expect(value(result)).toMatchObject({ code: "research_record_invalid", message: expect.stringContaining("quote") });
    expect(record).not.toHaveBeenCalled();
  });

  it("answers short: the record's id, the check's word and what to do", async () => {
    const { target } = targetOf();
    const result = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
    expect(result.status).toBe("complete");
    expect(value(result)).toEqual({ message: "Recorded. The quote is on the page.", quote_check: "found", record_id: RECORD_ID });
    const noQuote = targetOf({ kind: "recorded", record: stored(null) });
    expect(value(await recordEvidenceEngineTool(noQuote.target, { kind: "main" }).execute(call(FINDING)))).toEqual({ message: "Recorded.", record_id: RECORD_ID });
  });

  it("says at once that a wrong quote is not on the page, and how to correct it", async () => {
    const { target } = targetOf({ kind: "recorded", record: stored({ reason: null, status: "not_verbatim" }) });
    const result = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
    expect(result.status).toBe("complete");
    expect(value(result)).toMatchObject({ quote_check: "not_verbatim", record_id: RECORD_ID });
    expect(value(result).message).toMatch(/not on the page.*supersedes.*while you still have the page/u);
  });

  it.each([
    ["found", "other_page", /another page you opened.*supersedes/u],
    ["unsupported", "not_in_opened_text", /fetch_url or the browser.*supersedes/u],
    ["unsupported", "search_snippet_only", /snippet is no evidence.*supersedes/u],
    ["not_checked", "browser_page", /not in what the browser printed.*supersedes/u],
    ["not_checked", "other_tool_output", /another tool's output.*supersedes/u],
    ["not_checked", "page_not_stored", /keeps no more page text/u],
    ["not_checked", "page_truncated", /past that point/u],
    ["not_checked", "partial_source", /only part of this page/u],
    ["not_checked", "sources_over_limit", /older ones are not read/u],
    ["not_checked", "sources_unreadable", /could not be read/u],
    ["not_checked", null, /the record stands/u]
  ] as const)("tells the agent what %s (%s) asks of it", async (status, reason, message) => {
    const { target } = targetOf({ kind: "recorded", record: stored({ reason, status }) });
    expect(value(await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING))).message).toMatch(message);
  });

  it("hands a refusal to the agent with its code and message, and a failure to the batch", async () => {
    const refused = targetOf({ code: "research_records_full", kind: "refused", message: "Nothing was recorded." });
    const result = await recordEvidenceEngineTool(refused.target, { kind: "main" }).execute(call(FINDING));
    expect(result.status).toBe("error");
    expect(value(result)).toEqual({ code: "research_records_full", message: "Nothing was recorded." });
    const failing = { evidence: { record: vi.fn(async () => { throw new Error("down"); }) }, researching: () => true };
    await expect(recordEvidenceEngineTool(failing, { kind: "main" }).execute(call(FINDING))).rejects.toThrow("down");
  });

  it("is never tried again by itself, and is the agent's own step", () => {
    const tool = recordEvidenceEngineTool(targetOf().target, { kind: "main" });
    expect(tool.effects).toBe("local");
    expect(tool.activity({ arguments: {}, id: "c", name: RECORD_EVIDENCE_TOOL_NAME })).toEqual({ origin: "tool", serverName: "Research", toolName: "Recording evidence" });
  });
});
