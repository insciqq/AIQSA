import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RECORD_EVIDENCE_TOOL_NAME, RESEARCH_EVIDENCE_LIMITS, type ResearchEvidenceRecord } from "../../contracts/research";
import type { EngineToolExecution } from "../engine/toolRegistry";
import { recordEvidenceEngineTool } from "../tools/recordEvidence";
import type { ToolExecutionResult } from "../tools/types";
import { WORKSPACE_GUIDE_FILES, WORKSPACE_GUIDE_PATHS, workspaceGuideInput } from "../workspace/guides";
import { researchClaimGivesRate, researchCountWords, researchDatasetWords, researchSampleIsSmall, researchSmallSampleNote, RESEARCH_REVIEWS_GUIDANCE, RESEARCH_REVIEWS_GUIDE_PATH,
  RESEARCH_REVIEWS_REFERENCE, RESEARCH_SMALL_SAMPLE_BELOW } from "./dataCollection";
import type { ResearchEvidenceAppend, ResearchEvidenceRepository } from "./evidenceRepository";
import { createResearchEvidenceStore } from "./evidenceStore";
import { researcherBrief, researcherMethodFooter } from "./method";
import type { ResearchRunScope } from "./ports";
import type { ResearchAgentCall } from "./sources";

const CARD = "https://market.example/product/lumo-flex-20";
const SHELL = "mcp__workspace__sandbox_shell";
const HTML = readFileSync(join(process.cwd(), "tests/fixtures/research/marketplace-card.html"), "utf8");

const textOf = (html: string) => html.replace(/<[^>]+>/gu, "\n").replace(/\n\s*\n+/gu, "\n").trim();

/** What `aiqsa-browser text` prints of the card, after the step line of the command that opened it. */
const PRINTED = `[browser #3 · reviews] open @ market.example/product/lumo-flex-20\n${textOf(HTML.slice(HTML.indexOf("<body>")))}`;

/** The researcher's script, as the guide has it: each review's own text decides its variant, never the size selected on the card. */
function collect(html: string) {
  const reviews = [...html.matchAll(/<article class="review">([\s\S]*?)<\/article>/gu)].map((match) => textOf(match[1]!));
  const sized = (size: string) => new RegExp(`${size}\\s*(?:×|на)\\s*200`, "u");
  const keptOf = reviews.filter((review) => sized("160").test(review) && !review.includes("Flex 24"));
  // `посередине просел` is a complaint and `не просел` is none, hence the word's start.
  const complaint = (review: string, word: RegExp) => word.test(review) && !new RegExp(`(?:(?<!\\p{L})не\\s+${word.source}|${word.source}а\\s+нет)`, "iu").test(review);
  return {
    kept: keptOf,
    left: { model: reviews.filter((review) => review.includes("Flex 24")).length, noSize: reviews.filter((review) => !/\d{3}\s*(?:×|на)\s*200/u.test(review)).length,
      otherSize: reviews.filter((review) => sized("1[48]0").test(review)).length },
    long: keptOf.filter((review) => review.includes("более года")),
    read: reviews.length,
    sagging: keptOf.filter((review) => complaint(review, /просел/iu)),
    smell: keptOf.filter((review) => complaint(review, /запах/iu))
  };
}

const quoteOf = (review: string) => review.split("\n").at(-1)!;

/** What a fake model hands `record_evidence` from what the script found. */
function datasetCall(found: ReturnType<typeof collect>) {
  const { left, long, read, sagging, kept, smell } = found;
  return { claim: `Sagging: ${sagging.length} of ${kept.length} owners of the 160×200 report it.`, criterion_key: "durability", kind: "dataset", quote: null, reason: null, row_key: "lumo-flex-20-160x200",
    source_class: "owner_reviews", standing: "confirmed", supersedes: null, target: null, url: CARD,
    dataset: { counts: [{ count: sagging.length, label: "sagging" }, { count: smell.length, label: "smell" }, { count: long.length, label: "owned a year or more" }],
      examples: sagging.map((review) => ({ quote: quoteOf(review), url: CARD })),
      left_out: `${left.otherSize} of other sizes, ${left.model} of Lumo Flex 24, ${left.noSize} naming no size, out of ${read} on the card.`,
      method: "Read every review on the card in the browser and kept those whose own text names Lumo Flex 20 at 160×200.", sample_size: kept.length } };
}

/** The real store and its real quote check over one agent's calls, with its rows in memory. */
function storeOf(calls: readonly ResearchAgentCall[]) {
  const appended: ResearchEvidenceAppend[] = [];
  const repository = {
    agentCalls: () => ({ calls: async (_agent: unknown, ids: readonly string[]) => calls.filter((one) => ids.includes(one.id)), fetchCalls: async () => [], recentCalls: async () => [...calls].reverse() }),
    append: async (_scope: unknown, write: ResearchEvidenceAppend) => {
      appended.push(write);
      return { kind: "recorded" as const, record: { ...write.record, id: "record-1", pageId: write.page ? "page-1" : null, quoteCheck: write.quoteCheck.kept } as unknown as ResearchEvidenceRecord };
    },
    chain: async () => ["run-1"]
  } as unknown as ResearchEvidenceRepository;
  const run = { branchRunIds: [], chatId: "chat", researchRunId: "run-1", runId: "run-1", userId: "user" } as unknown as ResearchRunScope;
  const port = createResearchEvidenceStore({ repository, savedResults: { read: vi.fn(async () => null) }, threads: { backgroundRunIds: vi.fn(async () => []) } as never })(run);
  return { appended, tool: recordEvidenceEngineTool({ coverage: { frame: async () => null }, evidence: port, researching: () => true }, { kind: "subagent", name: "reviews", threadId: "thread-1" }) };
}

const shellCall = (id: string, command: string, text: string): ResearchAgentCall =>
  ({ arguments: { command }, id, observationId: null, providerCallId: id, result: { callId: id, content: [{ text, type: "text" }], name: SHELL, status: "complete" }, toolName: SHELL });

const BROWSER_SCRIPT = "python3 - <<'PY'\nfrom aiqsa import browser as b\nprint(b.text())\nPY";

const execution = (args: Record<string, unknown>): EngineToolExecution =>
  ({ call: { arguments: args, id: "call-1", name: RECORD_EVIDENCE_TOOL_NAME }, ordinal: 0, persistedToolCallId: "row-1", round: 1, signal: new AbortController().signal });

const value = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("a tally's words", () => {
  it("says a sample below the bound in counts and marks it small, and a share only from the bound on", () => {
    expect(researchSampleIsSmall(RESEARCH_SMALL_SAMPLE_BELOW - 1)).toBe(true);
    expect(researchSampleIsSmall(RESEARCH_SMALL_SAMPLE_BELOW)).toBe(false);
    expect(researchCountWords(3, 11)).toBe("3 of 11");
    expect(researchCountWords(9, RESEARCH_SMALL_SAMPLE_BELOW - 1)).toBe(`9 of ${RESEARCH_SMALL_SAMPLE_BELOW - 1}`);
    expect(researchCountWords(9, RESEARCH_SMALL_SAMPLE_BELOW)).toBe(`9 of ${RESEARCH_SMALL_SAMPLE_BELOW} (30%)`);
    expect(researchDatasetWords({ counts: [{ count: 3, label: "sagging" }, { count: 0, label: "smell" }], sampleSize: 11 })).toBe("Small sample of 11. sagging: 3 of 11; smell: 0 of 11.");
    expect(researchDatasetWords({ counts: [], sampleSize: 4 })).toBe("Small sample of 4.");
    expect(researchDatasetWords({ counts: [{ count: 30, label: "sagging" }], sampleSize: 120 })).toBe("Sample of 120. sagging: 30 of 120 (25%).");
  });

  it("never rounds a few to none or nearly all to all", () => {
    expect(researchCountWords(1, 400)).toBe("1 of 400 (under 1%)");
    expect(researchCountWords(399, 400)).toBe("399 of 400 (over 99%)");
    expect(researchCountWords(0, 400)).toBe("0 of 400 (0%)");
    expect(researchCountWords(400, 400)).toBe("400 of 400 (100%)");
  });

  it("has a word for a small sample and none for another, and knows a claim that reads as a rate", () => {
    expect(researchSmallSampleNote({ counts: [{ count: 3, label: "sagging" }], sampleSize: 11 })).toBe(
      `Small sample: 11, below ${RESEARCH_SMALL_SAMPLE_BELOW}. Report it as small and in counts (sagging: 3 of 11), never as a percentage.`);
    expect(researchSmallSampleNote({ counts: [], sampleSize: 11 })).toBe(`Small sample: 11, below ${RESEARCH_SMALL_SAMPLE_BELOW}. Report it as small and in counts, never as a percentage.`);
    expect(researchSmallSampleNote({ counts: [{ count: 3, label: "sagging" }], sampleSize: RESEARCH_SMALL_SAMPLE_BELOW })).toBeNull();
    for (const claim of ["27% report sagging.", "27 % жалуются.", "27 процентов жалуются.", "27 percent report sagging.", "27 por ciento se queja.", "El 27 per cent es queixa."]) expect(researchClaimGivesRate(claim)).toBe(true);
    expect(researchClaimGivesRate("3 of 11 report sagging.")).toBe(false);
  });
});

describe("the method on a saved card", () => {
  const found = collect(HTML);
  const args = datasetCall(found);

  it("filters a card's merged reviews by each review's own text", () => {
    expect(found).toMatchObject({ left: { model: 1, noSize: 2, otherSize: 5 }, read: 19 });
    expect(found.kept).toHaveLength(11);
    expect(found.sagging).toHaveLength(3);
    expect(found.smell).toHaveLength(2);
    expect(found.long).toHaveLength(4);
    // One owner names the size only in the body, and the negated complaints are no complaints.
    expect(found.sagging.join()).toContain("Брали 160 на 200");
    expect(found.sagging.join()).not.toContain("не просел совсем");
    expect(found.smell.join()).not.toContain("запаха нет");
    expect(PRINTED).toContain("Выбран размер: 160×200");
  });

  it("records a dataset whose examples are on the page, with its filtered count and what it left out", async () => {
    const { appended, tool } = storeOf([shellCall("c1", BROWSER_SCRIPT, PRINTED)]);
    const result = await tool.execute(execution(args));
    expect(result.status).toBe("complete");
    expect(value(result)).toMatchObject({ quote_check: "found", record_id: "record-1", sample: "small" });
    expect(value(result).message).toBe(`Recorded. The quote is on the page. Small sample: 11, below ${RESEARCH_SMALL_SAMPLE_BELOW}. Report it as small and in counts (sagging: 3 of 11), never as a percentage.`);
    const [write] = appended;
    const record = write!.record;
    if (record.kind !== "dataset") throw new Error(record.kind);
    expect(record).toMatchObject({ criterionKey: "durability", rowKey: "lumo-flex-20-160x200", sourceClass: "owner_reviews", standing: "confirmed", url: CARD });
    expect(record.dataset).toMatchObject({ leftOut: "5 of other sizes, 1 of Lumo Flex 24, 2 naming no size, out of 19 on the card.", sampleSize: 11 });
    expect(researchDatasetWords(record.dataset)).toBe("Small sample of 11. sagging: 3 of 11; smell: 2 of 11; owned a year or more: 4 of 11.");
    expect(record.dataset.examples).toHaveLength(3);
    // The page goes with the record, under the card's link, so a verifier can read every example.
    expect(write!.page).toMatchObject({ obtainedBy: "browser", truncated: false, url: CARD });
    for (const example of record.dataset.examples) expect(write!.page!.text).toContain(example.quote);
  });

  it("takes a script file's output as a page by its step line", async () => {
    const { tool } = storeOf([shellCall("c1", "python3 /workspace/project/reviews.py", PRINTED)]);
    expect(value(await tool.execute(execution(args)))).toMatchObject({ quote_check: "found" });
  });

  it("says when an example is not what the browser printed, and when it was only read back from a file", async () => {
    const invented = { ...args, dataset: { ...args.dataset, examples: [...args.dataset.examples, { quote: "Просел за неделю, ужасно.", url: CARD }] } };
    const wrong = await storeOf([shellCall("c1", BROWSER_SCRIPT, PRINTED)]).tool.execute(execution(invented));
    expect(value(wrong)).toMatchObject({ quote_check: "not_checked" });
    expect(value(wrong).message).toContain("not in what the browser printed");
    const cat = shellCall("c1", "cat /workspace/project/reviews.txt", textOf(found.sagging.join("\n")));
    const fromFile = await storeOf([cat]).tool.execute(execution(args));
    expect(value(fromFile)).toMatchObject({ quote_check: "not_checked" });
    expect(value(fromFile).message).toContain("another tool's output, which is no page");
  });

  it("refuses a dataset without a sample size or examples, with nothing written", async () => {
    const { appended, tool } = storeOf([shellCall("c1", BROWSER_SCRIPT, PRINTED)]);
    const without = (change: Record<string, unknown>) => ({ ...args, dataset: { ...args.dataset, ...change } });
    const { sample_size: _sampleSize, ...noSample } = args.dataset;
    const { examples: _examples, ...noExamples } = args.dataset;
    for (const [dataset, field] of [[noSample, "dataset.sample_size"], [noExamples, "dataset.examples"]] as const) {
      expect(value(await tool.execute(execution({ ...args, dataset })))).toMatchObject({ code: "research_record_invalid", message: expect.stringContaining(field) });
    }
    for (const [change, field] of [[{ sample_size: 0 }, "dataset.sample_size"], [{ sample_size: RESEARCH_EVIDENCE_LIMITS.sampleSize + 1 }, "dataset.sample_size"], [{ examples: [] }, "dataset.examples"]] as const) {
      expect(value(await tool.execute(execution(without(change))))).toMatchObject({ code: "research_record_invalid", message: expect.stringContaining(field) });
    }
    expect(value(await tool.execute(execution({ ...args, dataset: null })))).toMatchObject({ code: "research_record_invalid" });
    // The refusal means by a sample what the schema does: the filtered number, not all that was read.
    expect(value(await tool.execute(execution(without({ sample_size: 0 }))))).toMatchObject({ message: expect.stringContaining("those kept after filtering") });
    expect(appended).toHaveLength(0);
  });
});

describe("where a researcher reads the method", () => {
  it("is a section of the browser guide, which every Workspace gets within the installer's bounds", () => {
    expect(RESEARCH_REVIEWS_GUIDE_PATH).toBe(WORKSPACE_GUIDE_PATHS.browser);
    const browser = WORKSPACE_GUIDE_FILES.find((file) => file.path === WORKSPACE_GUIDE_PATHS.browser)!.content;
    expect(browser).toContain(RESEARCH_REVIEWS_GUIDANCE);
    // MAX_FILE in `lib/server/workspace/guideGuest.ts`.
    expect(Buffer.byteLength(browser)).toBeLessThanOrEqual(32_768);
    for (const agentKind of ["main", "subagent"] as const) expect(workspaceGuideInput({ agentKind }).toString("utf8")).toContain("## Owners' reviews as counts");
  });

  describe("in an ordinary run", () => {
    // One guide per VM serves every run of a chat, written at boot, so it cannot vary by run: it says who has the tool.
    const guide = (JSON.parse(workspaceGuideInput().toString("utf8")) as { guides: { content: string; name: string }[] }).guides.find(({ name }) => name === "browser.md")!.content;
    const section = guide.slice(guide.indexOf("## Owners' reviews as counts"));

    it("names the tool only where a research run offers it", () => {
      const lines = section.split("\n").filter((line) => line.includes(RECORD_EVIDENCE_TOOL_NAME));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain(`Only a research run offers ${RECORD_EVIDENCE_TOOL_NAME}: if this one does, call it`);
      expect(section).not.toMatch(new RegExp(`(?:^|- )Call ${RECORD_EVIDENCE_TOOL_NAME}`, "mu"));
    });

    it("says what to do without it, so a count still reaches the user", () => {
      expect(section).toContain("give the sample, the counts, what you dropped and a few reviews word for word in your answer");
    });

    it("keeps what only a record has to research too", () => {
      for (const word of ["`not_found`", "`unreachable`"]) expect(section.split("\n").find((line) => line.includes(word))).toMatch(/in research/iu);
    });
  });

  it("is named at the end of every brief", () => {
    const plan = { goal: "Choose.", questions: [{ question: "Which one?", sites: [], sourceClasses: [] }], skipped: [] };
    expect(researcherMethodFooter(plan)).toContain(RESEARCH_REVIEWS_REFERENCE);
    expect(researcherBrief("Cover it.", plan)).toContain(RESEARCH_REVIEWS_GUIDE_PATH);
  });

  it("calls a read count confirmed, since it is of what owners wrote, and never a party's claim", () => {
    expect(RESEARCH_REVIEWS_GUIDANCE).toContain("`standing` confirmed when you read the examples on the page (the count is of what owners wrote, not proof that the complaint is true)");
    expect(RESEARCH_REVIEWS_GUIDANCE).not.toContain("`standing` claimed");
  });

  it("holds the small sample's bound, and goes past no block", () => {
    expect(RESEARCH_REVIEWS_GUIDANCE).toContain(`Fewer than ${RESEARCH_SMALL_SAMPLE_BELOW} kept reviews is a small sample`);
    expect(RESEARCH_REVIEWS_GUIDANCE).toContain("never work around it");
    expect(RESEARCH_REVIEWS_GUIDANCE).toContain("`unreachable`");
  });
});
