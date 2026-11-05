import { describe, expect, it, vi } from "vitest";
import {
  decodeResearchRecord,
  RECORD_EVIDENCE_TOOL_NAME,
  RESEARCH_RECORD_KINDS,
  RESEARCH_SOURCE_CLASSES,
  RESEARCH_STANDINGS,
  type ResearchEvidenceRecord,
  type ResearchFrame,
  type ResearchStoredPage
} from "../../contracts/research";
import { SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import { subagentOffersTool } from "../engine/subagents/registry";
import type { EngineToolExecution } from "../engine/toolRegistry";
import type { ResearchEvidenceAppend, ResearchEvidenceRepository } from "../research/evidenceRepository";
import { createResearchEvidenceStore } from "../research/evidenceStore";
import type { ResearchRunScope } from "../research/ports";
import type { ResearchAgentCall } from "../research/sources";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
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
  const page = vi.fn(async (): Promise<ResearchStoredPage | null> => null);
  return { page, record, target: { coverage: { frame: async () => frame }, evidence: { page, record }, researching: () => researching } satisfies RecordEvidenceTarget };
}

const signal = new AbortController().signal;

const call = (args: Record<string, unknown>): EngineToolExecution =>
  ({ call: { arguments: args, id: "call-1", name: RECORD_EVIDENCE_TOOL_NAME }, ordinal: 0, persistedToolCallId: "row-1", round: 1, signal });

const value = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("the record_evidence schema", () => {
  it("keeps a claim to what its quote shows, the cause of most partly verdicts on acceptance runs 2 and 3", () => {
    expect(properties.claim!.description).toMatch(/no more than its quote shows: .* goes in a record of its own with a quote that holds it, or stays out\./u);
    // On run 3 eight of fourteen partly verdicts were claims that a page leaves a detail out, which part of a page cannot show.
    expect(properties.claim!.description).toMatch(/What a page leaves out is no finding: record not_found for that cell\.$/u);
  });

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

  it("reaches every researcher whatever its tool groups: research would read one that cannot record as exhausted", () => {
    expect(subagentOffersTool(recordEvidenceTool, null)).toBe(true);
    expect(subagentOffersTool(recordEvidenceTool, [])).toBe(true);
    expect(subagentOffersTool(recordEvidenceTool, [SUBAGENT_TOOL_GROUPS.web_fetch])).toBe(true);
  });
});

describe("a record's reason", () => {
  it("is written for a reader in the goal's language, since a real run's raw reason, naming fetch_url, reached a Russian answer", () => {
    expect(properties.reason!.description).toContain("in the language of the research goal");
    expect(properties.reason!.description).toContain("name no tool");
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
    const failing = { coverage: { frame: async () => null }, evidence: { page: async () => null, record: vi.fn(async () => { throw new Error("down"); }) }, researching: () => true };
    await expect(recordEvidenceEngineTool(failing, { kind: "main" }).execute(call(FINDING))).rejects.toThrow("down");
  });

  describe("and the matrix", () => {
    const FRAME: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Firmness", key: "firmness", why: "It decides comfort." }], rows: [{ key: "x1", label: "X1" }] };
    const at = (rowKey: string | null, criterionKey: string | null) => ({ ...stored({ reason: null, status: "found" }), claim: FINDING.claim, criterionKey, kind: "finding",
      pageId: null, quote: FINDING.quote, rowKey }) as ResearchEvidenceRecord;
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

  describe("and the claim's figures", () => {
    const CLAIM = "Слои: латекс 3 см, кокос 1 см.";
    const finding = (quote: string, pageId: string | null = "page-1", claim = CLAIM) =>
      ({ ...stored({ reason: null, status: "found" }), claim, kind: "finding", pageId, quote }) as ResearchEvidenceRecord;
    const pageOf = (text: string, truncated = false) => ({ id: "page-1", text, truncated }) as ResearchStoredPage;
    async function result(record: ResearchEvidenceRecord, stored: ResearchStoredPage | null | Error = null) {
      const { page, target } = targetOf({ kind: "recorded", record });
      page.mockImplementation(async () => { if (stored instanceof Error) throw stored; return stored; });
      const written = await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING));
      expect(written.status).toBe("complete");
      return { page, value: value(written) as { figures?: { not_in_quote: string[]; on_page: string[] }; message: string; record_id: string } };
    }

    it("names each figure the quote lacks, and asks for its passage or a narrower claim, keeping the record", async () => {
      const { value: answer } = await result(finding("латекс, кокос", null));
      expect(answer).toMatchObject({ figures: { not_in_quote: ["3 см", "1 см"], on_page: [] }, quote_check: "found", record_id: RECORD_ID });
      expect(answer.message).toBe("Recorded. The quote is on the page. The claim says more than its quote (3 см, 1 см: not in the quote). The record stands; to correct it, " +
        "call record_evidence again with supersedes set to this record's id and either a quote of the passage that holds each figure or a claim narrowed to what the quote says.");
    });

    it("says the figures are on the stored page but not in the quote, reading the stored page and not the agent's context", async () => {
      const { page, value: answer } = await result(finding("латекс, кокос"), pageOf("Состав: латекс, кокос. Толщина слоёв: латекс 3 см, кокос 1 см."));
      expect(page).toHaveBeenCalledWith("page-1", signal);
      expect(answer.figures).toEqual({ not_in_quote: ["3 см", "1 см"], on_page: ["3 см", "1 см"] });
      expect(answer.message).toContain("(3 см, 1 см: on the page but not in the quote)");
    });

    it("tells the figures on the page from those nowhere", async () => {
      const { value: answer } = await result(finding("латекс, кокос"), pageOf("Состав: латекс, кокос. Латекс 3 см."));
      expect(answer.figures).toEqual({ not_in_quote: ["3 см", "1 см"], on_page: ["3 см"] });
      expect(answer.message).toContain("(3 см: on the page but not in the quote; 1 см: neither in the quote nor on the page)");
    });

    it("matches a price however a page groups and names it", async () => {
      const { value: answer } = await result(finding("Матрас Lumo Flex 20", "page-1", "Lumo Flex 20 стоит 59 732 ₽."), pageOf("Матрас Lumo Flex 20. Цена: 59732 руб."));
      expect(answer.figures).toEqual({ not_in_quote: ["59 732 ₽"], on_page: ["59 732 ₽"] });
      expect((await result(finding("Цена: 59 732 руб.", "page-1", "Lumo Flex 20 стоит 59 732 ₽."))).value).not.toHaveProperty("figures");
    });

    it("says only that a figure is not in the quote when the page is kept in part or cannot be read", async () => {
      expect((await result(finding("латекс, кокос"), pageOf("Состав: латекс, кокос.", true))).value.message).toContain("(3 см, 1 см: not in the quote)");
      const failed = await result(finding("латекс, кокос"), new Error("down"));
      expect(failed.value).toMatchObject({ figures: { not_in_quote: ["3 см", "1 см"], on_page: [] }, record_id: RECORD_ID });
    });

    it("says nothing, and reads no page, when the quote holds every figure or the claim gives none", async () => {
      const held = await result(finding("латекс 3 см, кокос 1 см"), pageOf("латекс 3 см, кокос 1 см"));
      expect(held.value).toEqual({ message: "Recorded. The quote is on the page.", quote_check: "found", record_id: RECORD_ID });
      expect(held.page).not.toHaveBeenCalled();
      const none = await result(finding("held up", "page-1", "The X1 holds up, rated 4.8 of 5."), pageOf("held up"));
      expect(none.value).not.toHaveProperty("figures");
      expect(none.page).not.toHaveBeenCalled();
    });
  });

  it("asks for a page the check can read when the quote rests on shell output or on no page", async () => {
    const advice = "open this page with fetch_url or the browser so the check can read it; text from shell downloads or third-party readers cannot be checked.";
    for (const reason of ["other_tool_output", "not_in_opened_text"]) {
      const { target } = targetOf({ kind: "recorded", record: stored({ reason, status: reason === "other_tool_output" ? "not_checked" : "unsupported" }) });
      const { message } = value(await recordEvidenceEngineTool(target, { kind: "main" }).execute(call(FINDING))) as { message: string };
      expect(message).toContain(advice);
      expect(message).toContain("supersedes");
    }
  });

  describe("over the real store and quote check", () => {
    const SHELL = "mcp__workspace__sandbox_shell";
    const CARD = "https://shop.example/lumo-flex-20";
    const shell = (id: string, command: string, text: string): ResearchAgentCall =>
      ({ arguments: { command }, id, observationId: null, providerCallId: id, result: { callId: id, content: [{ text, type: "text" }], name: SHELL, status: "complete" }, toolName: SHELL });

    /** One agent's calls, with the rows the store writes kept in memory and its page read back by id. `browser`: the agent drives the Workspace browser. */
    function toolOf(calls: readonly ResearchAgentCall[], browser = false) {
      const appended: ResearchEvidenceAppend[] = [];
      const repository = {
        agentCalls: () => ({
          attempts: async (_agent: unknown, { toolNames }: Readonly<{ toolNames: readonly string[] }>) => [...calls].reverse().filter((one) => toolNames.includes(one.toolName)),
          calls: async (_agent: unknown, ids: readonly string[]) => calls.filter((one) => ids.includes(one.id)), fetchCalls: async () => [],
          recentCalls: async () => [...calls].reverse() }),
        append: async (_scope: unknown, write: ResearchEvidenceAppend) => {
          appended.push(write);
          return { kind: "recorded" as const, record: { ...write.record, id: RECORD_ID, pageId: write.page ? "page-1" : null, quoteCheck: write.quoteCheck.kept } as unknown as ResearchEvidenceRecord };
        },
        chain: async () => ["run-1"],
        page: async (_scope: unknown, _runs: unknown, pageId: string) => pageId === "page-1" && appended.at(-1)?.page ? { id: pageId, ...appended.at(-1)!.page! } : null
      } as unknown as ResearchEvidenceRepository;
      const run = { branchRunIds: [], chatId: "chat", researchRunId: "run-1", runId: "run-1", userId: "user" } as unknown as ResearchRunScope;
      const evidence = createResearchEvidenceStore({ repository, savedResults: { read: vi.fn(async () => null) }, threads: { backgroundRunIds: vi.fn(async () => []) } as never })(run);
      const tool = recordEvidenceEngineTool({ coverage: { frame: async () => null }, evidence, researching: () => true }, { kind: "subagent", name: "shops", threadId: "thread-1" },
        { browser: () => browser });
      return Object.assign(tool, { appended });
    }

    const price = { ...FINDING, claim: "Lumo Flex 20 стоит 59 732 ₽.", quote: "Матрас Lumo Flex 20", source_class: "action_channel", url: CARD };

    it("finds a price the quote lacks on the page the browser printed", async () => {
      const tool = toolOf([shell("c1", "aiqsa-browser text", "[browser #2 · shops] open @ shop.example/lumo-flex-20\nМатрас Lumo Flex 20\nЦена: 59732 руб.")]);
      const answer = value(await tool.execute(call(price)));
      expect(answer).toMatchObject({ figures: { not_in_quote: ["59 732 ₽"], on_page: ["59 732 ₽"] }, quote_check: "found", record_id: RECORD_ID });
      expect(tool.appended[0]!.quoteCheck.kept).toEqual({ reason: null, status: "found" });
    });

    it("marks a quote found in browser output with no address of its own, which opens no closed site", async () => {
      const tool = toolOf([shell("c1", "aiqsa-browser text", "Матрас Lumo Flex 20\nЦена: 59732 руб.")]);
      expect(value(await tool.execute(call(price)))).toMatchObject({ quote_check: "found", record_id: RECORD_ID });
      expect(tool.appended[0]!.quoteCheck.kept).toEqual({ reason: "unaddressed_page", status: "found" });
      expect(tool.appended[0]!.page).toMatchObject({ obtainedBy: "browser", url: CARD });
    });

    it("asks for the page itself when the text came from a shell download through a third-party reader", async () => {
      const tool = toolOf([shell("c1", `curl -s https://r.jina.ai/${CARD}`, "Матрас Lumo Flex 20\nЦена: 59 732 ₽")]);
      const answer = value(await tool.execute(call(price))) as { message: string };
      expect(answer).toMatchObject({ figures: { not_in_quote: ["59 732 ₽"], on_page: [] }, quote_check: "not_checked", record_id: RECORD_ID });
      expect(answer.message).toContain("open this page with fetch_url or the browser so the check can read it; text from shell downloads or third-party readers cannot be checked");
    });

    describe("and an unreachable site (operator decision 2026-11-05: the browser comes first)", () => {
      const EXEC = namespacedWorkspaceToolName("sandbox_exec");
      /** A command's call row as the Workspace keeps it: JSON whose `stdout` holds what the command printed. */
      const exec = (id: string, args: Record<string, unknown>, stdout: string): ResearchAgentCall => ({ arguments: args, id, observationId: null, providerCallId: id,
        result: { callId: id, content: [{ text: JSON.stringify({ data: { exitCode: 0, stderr: "", stdout, success: true }, ok: true }), type: "text" }], name: EXEC,
          status: "complete" }, toolName: EXEC });
      const unreachable = (target: string) => ({ ...NONE, kind: "unreachable", reason: "Проверка браузера не проходит.", target });

      it("is refused, with nothing written and its next step, before the agent's browser tried the site", async () => {
        const tool = toolOf([exec("c1", { args: ["open", "https://other.example/"], command: "aiqsa-browser" }, "[browser #1 · shops] open @ other.example/")], true);
        const result = await tool.execute(call(unreachable("https://www.shop.example/card")));
        expect(result.status).toBe("error");
        expect(value(result)).toMatchObject({ code: "research_unreachable_browser_first" });
        const { message } = value(result) as { message: string };
        expect(message).toContain("your Workspace browser has not opened shop.example in this research");
        expect(message).toContain("/workspace/guides/browser.md");
        expect(message).toContain("wait about 15 seconds and read it once more");
        expect(message).toContain("never solve or click a check");
        expect(tool.appended).toEqual([]);
      });

      it("is recorded at once for an agent without the browser", async () => {
        const tool = toolOf([], false);
        expect(value(await tool.execute(call(unreachable("shop.example"))))).toMatchObject({ record_id: RECORD_ID });
        expect(tool.appended).toHaveLength(1);
      });

      it("is recorded once the agent's browser opened the host or was refused on it, www. or not", async () => {
        const refused = toolOf([exec("c1", { args: ["open", "https://www.shop.example/card?id=1"], command: "aiqsa-browser" }, "error[navigation_failed]: The page refused.")], true);
        expect(value(await refused.execute(call(unreachable("shop.example"))))).toMatchObject({ record_id: RECORD_ID });
        const script = toolOf([exec("c1", { args: ["-c", "from aiqsa import browser as b; b.open(link); print(b.page_info())"], command: "python3" },
          "Opening the card.\n[browser #4 · shops] open @ www.shop.example/card\nChecking your browser.")], true);
        expect(value(await script.execute(call(unreachable("https://shop.example/"))))).toMatchObject({ record_id: RECORD_ID });
      });

      it("counts a host, not its domain, and never a step line a non-browser command printed", async () => {
        const subdomain = toolOf([exec("c1", { args: ["open", "https://market.portal.example/item"], command: "aiqsa-browser" }, "[browser #1 · shops] open @ market.portal.example/item")], true);
        expect((await subdomain.execute(call(unreachable("portal.example")))).status).toBe("error");
        expect(value(await subdomain.execute(call(unreachable("market.portal.example"))))).toMatchObject({ record_id: RECORD_ID });
        const faked = toolOf([exec("c1", { args: ["[browser #1] open @ shop.example/"], command: "echo" }, "[browser #1] open @ shop.example/")], true);
        expect((await faked.execute(call(unreachable("shop.example")))).status).toBe("error");
      });

      it("counts only a navigation the browser ran, never a proxied command, a proxy listing, an echo or a step line a script printed", async () => {
        const SHELL = namespacedWorkspaceToolName("sandbox_shell");
        const shellLine = (command: string, stdout: string): ResearchAgentCall => ({ ...exec("s1", { command }, stdout), toolName: SHELL });
        for (const notOpened of [
          exec("c1", { args: ["proxied", "curl", "-I", "https://shop.example/"], command: "aiqsa-browser" }, "HTTP/2 403"),
          exec("c1", { args: ["proxies", "https://shop.example/"], command: "aiqsa-browser" }, "shop.example opens directly."),
          exec("c1", { args: ["text"], command: "aiqsa-browser" }, "[browser #2 · shops] text @ shop.example/card\nA card."),
          exec("c1", { args: ["-c", "from aiqsa import browser as b\nprint('[browser #1] open @ shop.example/')"], command: "python3" }, "[browser #1] open @ shop.example/"),
          exec("c1", { args: ["https://shop.example/", "[browser #1] open @ shop.example/"], command: "printf" }, "[browser #1] open @ shop.example/"),
          shellLine("echo \"aiqsa-browser open https://shop.example/\"", "aiqsa-browser open https://shop.example/"),
          shellLine("echo aiqsa-browser open https://shop.example/; cat notes.txt", "[browser #1] open @ shop.example/"),
          shellLine("aiqsa-browser proxied curl -sS https://shop.example/ | head", "<html>")
        ]) {
          const tool = toolOf([notOpened], true);
          expect(value(await tool.execute(call(unreachable("shop.example"))))).toMatchObject({ code: "research_unreachable_browser_first" });
        }
        for (const opened of [
          shellLine("cd /workspace/project && aiqsa-browser open --proxy KZ1 'https://www.shop.example/card'", ""),
          shellLine("python3 - <<'EOF'\nfrom aiqsa import browser as b\nb.open(\"https://shop.example/card\")\nEOF", ""),
          exec("c1", { args: ["new-tab", "--quiet", "https://shop.example/card"], command: "/usr/local/bin/aiqsa-browser" }, ""),
          exec("c1", { args: ["-c", "aiqsa-browser open \"$1\"", "sh", "https://shop.example/"], command: "bash" },
            "[browser #1 · shops] open @ shop.example/"),
          exec("c1", { args: ["open", "https://short.example/r"], command: "aiqsa-browser" }, "[browser #1 · shops] open @ www.shop.example/card")
        ]) {
          const tool = toolOf([opened], true);
          expect(value(await tool.execute(call(unreachable("shop.example"))))).toMatchObject({ record_id: RECORD_ID });
        }
      });

      it("is not held back when the agent's calls cannot be read, or by a store that cannot say", async () => {
        const { record, target } = targetOf();
        const browsed = vi.fn(async () => { throw new Error("database down"); });
        await recordEvidenceEngineTool({ ...target, evidence: { ...target.evidence, browsed } }, { kind: "main" }, { browser: () => true }).execute(call(unreachable("shop.example")));
        await recordEvidenceEngineTool(target, { kind: "main" }, { browser: () => true }).execute(call(unreachable("shop.example")));
        expect(browsed).toHaveBeenCalledWith({ name: null, threadId: null }, "shop.example", signal);
        expect(record).toHaveBeenCalledTimes(2);
      });
    });
  });

  it("is never tried again by itself, and is the agent's own step", () => {
    const tool = recordEvidenceEngineTool(targetOf().target, { kind: "main" });
    expect(tool.effects).toBe("local");
    expect(tool.activity({ arguments: {}, id: "c", name: RECORD_EVIDENCE_TOOL_NAME })).toEqual({ origin: "tool", serverName: "Research", toolName: "Recording evidence" });
  });
});
