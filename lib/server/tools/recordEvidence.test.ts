import { describe, expect, it, vi } from "vitest";
import {
  decodeResearchRecord,
  RECORD_EVIDENCE_TOOL_NAME,
  RESEARCH_RECORD_KINDS,
  RESEARCH_SOURCE_CLASSES,
  RESEARCH_STANDINGS,
  type ResearchEvidenceRecord,
  type ResearchFrame
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

const dataset = (sampleSize: number, claim = "Owners report sagging.") => ({ claim, dataset: { counts: [{ count: 3, label: "sagging" }], sampleSize }, id: RECORD_ID, kind: "dataset",
  quoteCheck: { reason: null, status: "found" } }) as unknown as ResearchEvidenceRecord;

const properties = recordEvidenceTool.inputSchema.properties as Record<string, Record<string, unknown>>;

function targetOf(written: Awaited<ReturnType<RecordEvidenceTarget["evidence"]["record"]>> = { kind: "recorded", record: stored({ reason: null, status: "found" }) }, researching = true,
  frame: ResearchFrame | null = null) {
  const record = vi.fn(async () => written);
  return { record, target: { coverage: { frame: async () => frame }, evidence: { record }, researching: () => researching } satisfies RecordEvidenceTarget };
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

  it("says at once that a dataset's sample is small, and to report it in counts", async () => {
    const small = await recordEvidenceEngineTool(targetOf({ kind: "recorded", record: dataset(11) }).target, { kind: "main" }).execute(call(FINDING));
    expect(value(small)).toMatchObject({ quote_check: "found", record_id: RECORD_ID, sample: "small" });
    expect(value(small).message).toMatch(/^Recorded\. The quote is on the page\. Small sample: 11.*sagging: 3 of 11.*never as a percentage\.$/u);
    expect(value(small).message).not.toContain("supersedes");
    const large = await recordEvidenceEngineTool(targetOf({ kind: "recorded", record: dataset(120) }).target, { kind: "main" }).execute(call(FINDING));
    expect(value(large)).toEqual({ message: "Recorded. The quote is on the page.", quote_check: "found", record_id: RECORD_ID });
  });

  it("asks for the claim in counts when a small sample's already gives a percentage", async () => {
    const record = dataset(11, "27% report sagging.");
    const result = await recordEvidenceEngineTool(targetOf({ kind: "recorded", record }).target, { kind: "main" }).execute(call(FINDING));
    expect(value(result).message).toMatch(/This claim gives a percentage: call record_evidence again with supersedes set to this record's id and the claim in counts\.$/u);
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
    const failing = { coverage: { frame: async () => null }, evidence: { record: vi.fn(async () => { throw new Error("down"); }) }, researching: () => true };
    await expect(recordEvidenceEngineTool(failing, { kind: "main" }).execute(call(FINDING))).rejects.toThrow("down");
  });

  describe("and the matrix", () => {
    const FRAME: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Firmness", key: "firmness", why: "It decides comfort." }], rows: [{ key: "x1", label: "X1" }] };
    const at = (rowKey: string | null, criterionKey: string | null) => ({ ...stored({ reason: null, status: "found" }), criterionKey, kind: "finding", rowKey }) as ResearchEvidenceRecord;
    const result = async (record: ResearchEvidenceRecord, frame: ResearchFrame | null = FRAME) =>
      value(await recordEvidenceEngineTool(targetOf({ kind: "recorded", record }, true, frame).target, { kind: "main" }).execute(call(FINDING))) as { matrix?: string; record_id: string };

    it("says nothing of a record at a known cell, or of a run with no frame", async () => {
      expect(await result(at("x1", "firmness"))).not.toHaveProperty("matrix");
      expect(await result(at("z9", "price"), null)).not.toHaveProperty("matrix");
    });

    it("keeps a record under a key the matrix lacks, and names the keys and how to add one", async () => {
      const { matrix, record_id: id } = await result(at("z9", "firmness"));
      expect(id).toBe(RECORD_ID);
      expect(matrix).toContain("This record stands but fills no cell: the matrix does not know row_key z9.");
      expect(matrix).toContain("Rows: x1. Criteria: firmness.");
      expect(matrix).toContain("change_research_frame");
      expect(matrix).toContain("supersedes");
      expect((await result(at("x1", "price"))).matrix).toContain("criterion_key price");
      expect((await result(at("z9", "price"))).matrix).toContain("row_key z9 or criterion_key price");
    });

    it("says a record with no key fills no cell, since nothing else would tell a researcher", async () => {
      expect((await result(at(null, "firmness"))).matrix).toContain("it gives no row_key");
      expect((await result(at("x1", null))).matrix).toContain("it gives no criterion_key");
    });

    it("counts a record at its criterion on a frame with no rows, and says how to add a row it names", async () => {
      const rowless = { ...FRAME, rows: [] };
      expect(await result(at(null, "firmness"), rowless)).not.toHaveProperty("matrix");
      const named = (await result(at("z9", "firmness"), rowless)).matrix;
      expect(named).toContain("This record counts for its criterion");
      expect(named).toContain("add its row with change_research_frame");
      expect((await result(at(null, "price"), rowless)).matrix).toContain("criterion_key price. Rows: none yet. Criteria: firmness.");
    });

    it("says nothing of an unreachable site, which belongs to no cell", async () => {
      expect(await result({ ...stored(null), criterionKey: null, kind: "unreachable", rowKey: null } as ResearchEvidenceRecord)).not.toHaveProperty("matrix");
    });

    it("stays short with a long matrix: a few keys and how many more", async () => {
      const rows = Array.from({ length: 60 }, (_value, index) => ({ key: `row-${index}`, label: "Row" }));
      const { matrix } = await result(at("z9", "firmness"), { ...FRAME, rows });
      expect(matrix).toContain("and 36 more");
      expect(matrix!.length).toBeLessThan(700);
    });

    it("costs only the hint when the matrix cannot be read: the record is on file", async () => {
      const target = { ...targetOf({ kind: "recorded", record: at("z9", "firmness") }).target, coverage: { frame: async () => { throw new Error("down"); } } };
      const written = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
      expect(written.status).toBe("complete");
      expect(value(written)).toMatchObject({ record_id: RECORD_ID });
    });
  });

  it("is never tried again by itself, and is the agent's own step", () => {
    const tool = recordEvidenceEngineTool(targetOf().target, { kind: "main" });
    expect(tool.effects).toBe("local");
    expect(tool.activity({ arguments: {}, id: "c", name: RECORD_EVIDENCE_TOOL_NAME })).toEqual({ origin: "tool", serverName: "Research", toolName: "Recording evidence" });
  });
});
