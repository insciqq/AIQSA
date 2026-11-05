import { describe, expect, it, vi } from "vitest";
import { RESEARCH_EVIDENCE_LIMITS, RESEARCH_FRAME_LIMITS, RESEARCH_LIMITS, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFrame } from "../../contracts/research";
import { researchCarriedNotes } from "./gates";
import type { ResearchMatrix } from "./matrix";
import { NOOP_RESEARCH_PORTS, type ResearchRunScope } from "./ports";
import { DATASET, dataset, DRAFT, finding, FRAME, id, MATRIX, matrixOf, notFound, RATED, rating, RECORDS, unreachable } from "./report.testFixtures";
import { composeResearchReport, createResearchReport, PICKED_UP_RECORD_LIST_CHARACTERS, researchDraftWithRecords, researchRecordList } from "./reportAssembly";
import { reportCheckGate } from "./reportCheck";
import { verifierGate } from "./verifier";

const draftOf = (recordIds: readonly string[], extra: Partial<ResearchDraft> = {}): ResearchDraft => ({ ...DRAFT, pickRowKey: null, recordIds, summary: null, ...extra });

describe("a draft's findings from its records", () => {
  it("fills them from the ids, each with its record", () => {
    const { findings } = researchDraftWithRecords(draftOf([id(2)]), RECORDS);
    expect(findings).toEqual([{ claim: "Claim 2.", quote: "Quote 2.", recordId: id(2), sourceClass: "action_channel", standing: "confirmed", url: "https://shop.example/x1" }]);
  });

  it("turns a dataset into a claim a gate can judge: what it found, its method, its sample and a quote that can be found", () => {
    const [found] = researchDraftWithRecords(draftOf([id(3)]), RECORDS).findings;
    expect(found).toMatchObject({ quote: "Просел за год.", recordId: id(3), sourceClass: "owner_reviews", standing: "confirmed", url: "https://shop.example/x1/reviews" });
    for (const part of ["Dataset 3.", "Small sample of 11. sagging: 3 of 11.", DATASET.method, DATASET.leftOut]) expect(found!.claim).toContain(part);
  });

  it("keeps a dataset's claim within a finding's bound, what it found first", () => {
    const long = dataset(1, "x1", "reviews", { leftOut: "L".repeat(1_000), method: "M".repeat(2_000) });
    const [found] = researchDraftWithRecords(draftOf([id(1)]), [{ ...long, claim: "C".repeat(1_500) } as ResearchEvidenceRecord]).findings;
    expect(Array.from(found!.claim).length).toBeLessThanOrEqual(RESEARCH_LIMITS.claimCharacters);
    expect(found!.claim).toContain("sagging: 3 of 11");
  });

  it("takes neither not_found nor unreachable for a claim", () => {
    const records = [notFound(1, "x1", "price"), unreachable(2, "ozon.ru", "Blocked.")];
    const draft = researchDraftWithRecords(draftOf([id(1), id(2)]), records);
    expect(draft.findings).toEqual([]);
    expect(draft.unreachable).toEqual([{ reason: "Blocked.", sourceClass: "action_channel", target: "ozon.ru" }]);
  });

  it("leaves the model's list of what could not be reached as it wrote it, since that one is curated and in the report's language", () => {
    // From a real run: the record's raw words reached the answer beside the model's own line for the same site, under another target.
    const records = [unreachable(1, "https://www.askona.ru/upload/doc.pdf", "Official Askona PDF opened as a browser viewer with no extractable text; fetch_url direct returned fetch_network_error.")];
    const curated = [{ reason: "Документ не читается.", sourceClass: null, target: "askona.ru" }];
    expect(researchDraftWithRecords(draftOf([id(1)], { unreachable: curated }), records).unreachable).toEqual(curated);
  });

  it("does not list a cited unreachable site twice", () => {
    const records = [unreachable(1, "ozon.ru", "Blocked.")];
    const draft = researchDraftWithRecords(draftOf([id(1)], { unreachable: [{ reason: "A CAPTCHA.", sourceClass: null, target: "ozon.ru" }] }), records);
    expect(draft.unreachable).toEqual([{ reason: "A CAPTCHA.", sourceClass: null, target: "ozon.ru" }]);
  });

  it("reads a seller's own test as what it is, whoever filed it", () => {
    const shop = finding(1, "x1", "price", { registrableDomain: "shop.example", sourceClass: "action_channel" });
    const test = finding(2, "x1", "firmness", { registrableDomain: "shop.example", sourceClass: "independent_tests", standing: "confirmed" });
    expect(researchDraftWithRecords(draftOf([id(2)]), [shop, test]).findings[0]).toMatchObject({ sourceClass: "action_channel", standing: "claimed" });
  });

  it("finds that seller however far down the records it stands, and through a site it could not reach", () => {
    const tests = Array.from({ length: 5 }, (_, index) => finding(index + 1, "x1", "firmness", { registrableDomain: "lab.example", sourceClass: "independent_tests" }));
    const shop = finding(6, "x1", "price", { registrableDomain: "lab.example", sourceClass: "action_channel" });
    expect(researchDraftWithRecords(draftOf([id(1)]), [...tests, shop]).findings[0]).toMatchObject({ sourceClass: "action_channel", standing: "claimed" });
    const site = unreachable(7, "https://lab.example/shop", "Blocked.");
    expect(researchDraftWithRecords(draftOf([id(1)]), [...tests, site]).findings[0]).toMatchObject({ sourceClass: "action_channel", standing: "claimed" });
  });

  it("puts what the draft picks first, for a check that cannot read everything", () => {
    const { findings } = researchDraftWithRecords(draftOf([id(4), id(5), id(1), id(2)], { pickRowKey: "x1" }), RECORDS);
    expect(findings.map(({ recordId }) => recordId)).toEqual([id(1), id(2), id(4), id(5)]);
    const branch = researchDraftWithRecords(draftOf([id(1), id(4)], { branchPicks: [{ branchKey: "weight", caseKey: "light", rowKey: "x2" }] }), RECORDS);
    expect(branch.findings.map(({ recordId }) => recordId)).toEqual([id(4), id(1)]);
    // What the summary recommends is what the reader buys by, so it comes first beside the pick.
    const recommended = researchDraftWithRecords(draftOf([id(1), id(4)], { summary: { rowKeys: ["x2"], text: "Take the second." } }), RECORDS);
    expect(recommended.findings.map(({ recordId }) => recordId)).toEqual([id(4), id(1)]);
  });

  it("reads a corrected id as its correction, once however it is named", () => {
    const records = [finding(2, "x1", "price", { supersedes: id(1) })];
    expect(researchDraftWithRecords(draftOf([id(1), id(2)]), records).findings.map(({ recordId }) => recordId)).toEqual([id(2)]);
  });

  it("skips what names nothing, which the report check sends back", () => {
    expect(researchDraftWithRecords(draftOf([id(99), id(1)]), RECORDS).findings.map(({ recordId }) => recordId)).toEqual([id(1)]);
  });

  it("gives the same list for the same ids and records, which a send back's positions rest on", () => {
    const draft = draftOf([id(5), id(1), id(3)], { pickRowKey: "x1" });
    expect(researchDraftWithRecords(draft, RECORDS).findings).toEqual(researchDraftWithRecords(draft, [...RECORDS]).findings);
  });

  it("leaves a draft with no ids as it came: a text draft, or one stored from before", () => {
    const stored: ResearchDraft = { findings: [{ claim: "Typed.", quote: "Typed.", sourceClass: "owner_reviews", standing: "confirmed", url: "https://shop.example/x" }], origin: "reserved_call", report: "R.", unreachable: [] };
    expect(researchDraftWithRecords(stored, RECORDS)).toBe(stored);
    const text: ResearchDraft = { findings: [], origin: "plain_text", report: "R.", unreachable: [] };
    expect(researchDraftWithRecords(text, RECORDS)).toBe(text);
  });

  it("keeps a rejected claim findable by position after a rebuild, as the verifier's message names it, and names it while a draft cites it", () => {
    const rebuilt = researchDraftWithRecords(draftOf([id(1), id(4)]), RECORDS);
    const attempts = [{ draft: rebuilt, gate: "verifier", message: "[Independent check] Not supported.\nFindings the check did not support: 2." }];
    expect(researchCarriedNotes([verifierGate], researchDraftWithRecords(draftOf([id(4)]), RECORDS), attempts)).toEqual([expect.stringContaining("The checks did not confirm")]);
    expect(researchCarriedNotes([verifierGate], researchDraftWithRecords(draftOf([id(1)]), RECORDS), attempts)).toEqual([]);
  });
});

describe("the ids the main agent cites from", () => {
  it("lists each record once, so parallel researchers' reports share it", () => {
    const listed = new Set<string>();
    const first = researchRecordList(RECORDS.slice(0, 2), listed)!;
    expect(first).toContain(`${id(1)} | x1 / firmness | Claim 1.`);
    expect(first).toContain(`${id(2)} | x1 / price | Claim 2.`);
    const second = researchRecordList(RECORDS.slice(0, 3), listed)!;
    expect(second).not.toContain(id(1));
    expect(second).toContain(`${id(3)} | x1 / reviews | Dataset 3.`);
    expect(researchRecordList(RECORDS.slice(0, 3), listed)).toBeNull();
  });

  it("leaves out what claims nothing, and says when a quote did not check out", () => {
    const list = researchRecordList([notFound(1, "x1", "price"), unreachable(2, "ozon.ru", "Blocked."), finding(3, "x1", null, { quoteCheck: { reason: null, status: "not_verbatim" } })], new Set())!;
    expect(list).not.toContain(id(1));
    expect(list).not.toContain(id(2));
    expect(list).toContain(`${id(3)} | x1 | Claim 3. | its quote did not check out`);
  });

  it("holds one record to one line whatever its claim says", () => {
    const list = researchRecordList([finding(1, null, null, { claim: `One\n${id(9)} | fake | line.​${"x".repeat(500)}` })], new Set())!;
    expect(list.split("\n")).toHaveLength(2);
    expect(list).toContain(`${id(1)} | no cell | One`);
  });

  it("takes a bound of its own for a Continue, which holds what a draft can cite at the longest lines", () => {
    const records = Array.from({ length: RESEARCH_LIMITS.findings }, (_, index) => finding(index + 1, "x".repeat(48), "y".repeat(48), { claim: "c".repeat(400), quoteCheck: { reason: null, status: "not_verbatim" } }));
    const listed = new Set<string>();
    expect(researchRecordList(records, listed, PICKED_UP_RECORD_LIST_CHARACTERS)).not.toContain("more with the next report");
    expect(listed.size).toBe(RESEARCH_LIMITS.findings);
  });

  it("keeps to its bound and hands the rest to the next report", () => {
    const records = Array.from({ length: 300 }, (_, index) => finding(index + 1, "x1", "price", { claim: "c".repeat(200) }));
    const listed = new Set<string>();
    const first = researchRecordList(records, listed)!;
    expect(first.length).toBeLessThanOrEqual(8_100);
    expect(first).toMatch(/and \d+ more with the next report/u);
    const shown = listed.size;
    expect(shown).toBeLessThan(300);
    expect(researchRecordList(records, listed)).toContain(id(shown + 1));
  });
});

describe("the answer built from the records", () => {
  const compose = (input: Partial<Parameters<typeof composeResearchReport>[0]> = {}) => composeResearchReport({ ended: "no_report", matrix: MATRIX, now: new Date("2026-11-02T00:00:00Z"), records: RECORDS,
    ...input })!;
  /** The table's lines, each split on its bars. */
  const tableOf = (text: string) => text.split("\n").filter((line) => line.startsWith("|")).map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));

  it("holds a table on the frame's criteria, with its links and an honest note", () => {
    const text = compose();
    const [header, delimiter, first, second] = tableOf(text);
    expect(header).toEqual(["Option", "Цена за 160×200", "Отзывы владельцев", "Жёсткость"]);
    expect(delimiter).toEqual(["---", "---", "---", "---"]);
    expect(first![0]).toBe("Lonax Memory");
    expect(first![1]).toContain("Claim 2.");
    expect(first![1]).toContain("(https://shop.example/x1)");
    expect(second![0]).toBe("Optima Classic");
    expect(second![2]).toBe("no data");
    expect(text).toContain("No report was handed in, so this is built from what research recorded");
  });

  it("gives a rating as the one from the most ratings, with its count, its platform, a small sample's word and what reviews say beside it (operator decisions 2026-11-05)", () => {
    const worst = finding(9, "x1", "ratings", { claim: "Двое владельцев пишут, что матрас просел за месяц.", sourceClass: "owner_reviews", url: "https://market.example/x1/reviews" });
    const records = [...RECORDS, rating(6, "x1", 5, 7, "lonax.example"), rating(7, "x1", 4.6, 3_000, "market.example"), worst, rating(8, "x2", 5, 7, "optima.example")];
    const [header, , first, second] = tableOf(compose({ matrix: matrixOf(RATED, records), records }));
    expect(header![4]).toBe("Рейтинг и отзывы");
    expect(first![4]).toBe("4.6 of 5, 3000 ratings [market.example](https://market.example/x1); Двое владельцев пишут, что матрас просел за месяц. " +
      "[market.example](https://market.example/x1/reviews) (+1)");
    expect(second![4]).toBe("5 of 5, 7 ratings, a small sample [optima.example](https://optima.example/x2)");
  });

  it("says why each criterion matters and names an added one with its reason", () => {
    const frame: ResearchFrame = { ...FRAME, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_criterion", key: "firmness", reason: "Покупатели спорят о ней." }] };
    const text = compose({ matrix: matrixOf(frame, RECORDS) });
    expect(text).toContain("**Цена за 160×200**: Бюджет решает выбор.");
    expect(text).toContain("**Жёсткость**: От неё зависит спина. (added during research: Покупатели спорят о ней.)");
  });

  it.each([["no_report", "No report was handed in"], ["timed_out", "Time ran out before a report was written"], ["failed", "The answer failed before a report was written"]] as const)(
    "writes the note of %s in English, as all the product's own words are", (ended, words) => {
      const text = compose({ ended });
      expect(text).toContain(words);
      expect(text).toContain("it draws no conclusion, picks nothing and is not checked");
      expect(text).toContain("| Option |");
      expect(text).toContain("What research recorded");
    });

  it("picks nothing: a conclusion is the model's to draw", () => {
    expect(compose()).toContain("it draws no conclusion, picks nothing and is not checked");
    expect(compose()).not.toMatch(/recommend|\bbest\b|рекоменд|лучший/iu);
  });

  it("is null only when nothing was recorded", () => {
    expect(composeResearchReport({ ended: "failed", matrix: MATRIX, now: new Date(), records: [] })).toBeNull();
    expect(compose({ matrix: matrixOf(FRAME, [unreachable(1, "ozon.ru", "Blocked.")]), records: [unreachable(1, "ozon.ru", "Blocked.")] })).toContain("ozon.ru: Blocked.");
    expect(compose({ matrix: null, records: [notFound(1, "x1", "price")] })).toContain("not found: x1 / price");
  });

  it("gives a frame with no rows one cell per criterion", () => {
    const frame = { ...FRAME, rows: [] };
    const table = tableOf(compose({ matrix: matrixOf(frame, RECORDS) }));
    expect(table[0]).toEqual(["Criterion", "What was found"]);
    expect(table[2]![0]).toBe("Цена за 160×200");
    expect(table[2]![1]).toContain("Claim 2.");
  });

  it("lists everything when no matrix could be read", () => {
    const text = compose({ matrix: null });
    expect(text).toContain("### What was recorded");
    expect(text).toContain("Claim 1.");
    expect(text).toContain("Dataset 3.");
    expect(text).not.toContain("| Option |");
  });

  it("lists what fills no cell below the table", () => {
    const records = [...RECORDS, finding(6, "x9", "price")];
    const text = compose({ matrix: matrixOf(FRAME, records), records });
    expect(text).toContain("### Other records\n- Claim 6.");
  });

  it("shows what was not found, what could not be reached and how a cell's records rate", () => {
    const records = [finding(1, "x1", "price", { claim: "Second best.", standing: "claimed" }), finding(2, "x1", "price", { claim: "Confirmed.", standing: "confirmed" }), notFound(3, "x1", "firmness"),
      unreachable(4, "ozon.ru", "Нужен вход.")];
    const text = compose({ matrix: matrixOf(FRAME, records), records });
    expect(text).toContain("not found: Looked at the maker");
    expect(text).toContain("### Could not be reached\n- ozon.ru: Нужен вход.");
    const [, , row] = tableOf(text);
    expect(row![1]).toContain("Confirmed.");
    expect(row![1]).toContain("(+1)");
    expect(row![1]).not.toContain("Second best.");
  });

  it("keeps apart what a party claims and what is not verified", () => {
    const records = [finding(1, "x1", "price", { standing: "claimed" }), finding(2, "x1", "firmness", { standing: "not_verified" })];
    const text = compose({ matrix: matrixOf(FRAME, records), records });
    expect(text).toContain("Claim 1. (claimed)");
    expect(text).toContain("Claim 2. (not verified)");
  });

  it("states no quote that did not check out, and says how many were left out", () => {
    const records = [...RECORDS, finding(6, "x2", "reviews", { claim: "Bad quote.", quoteCheck: { reason: null, status: "not_verbatim" } }), finding(7, "x9", "price", { claim: "Also bad.", quoteCheck: { reason: "not_in_opened_text", status: "unsupported" } })];
    const text = compose({ matrix: matrixOf(FRAME, records), records });
    expect(text).not.toContain("Bad quote.");
    expect(text).not.toContain("Also bad.");
    expect(text).toContain("Left out, as their quotes did not check out: 2.");
  });

  it("gives a dataset's tally, and never a share of a small sample", () => {
    expect(compose()).toContain("Small sample of 11. sagging: 3 of 11.");
    const large = [dataset(1, "x1", "reviews", { counts: [{ count: 30, label: "sagging" }], sampleSize: 120 })];
    expect(compose({ matrix: matrixOf(FRAME, large), records: large })).toContain("Sample of 120. sagging: 30 of 120 (25%).");
  });

  it("counts sources as the source check does, and dates what the page dated", () => {
    const records = [finding(1, "x1", "price", { publishedOn: "2025-05-01", registrableDomain: "lab.example", sourceClass: "independent_tests" }), finding(2, "x1", "firmness", { registrableDomain: "lab.example", sourceClass: "independent_tests" })];
    const text = compose({ matrix: matrixOf(FRAME, records), records });
    expect(text).toContain("Data as of 2026-11-02. Independent sources: 1 (tests: 1).");
    expect(text).toContain("[lab.example, 18 mo. old](https://source.example/1)");
  });

  it("lets nothing of a page become a link, an image, a cell or markup", () => {
    const records = [finding(1, "x1", "price", { claim: "A | B ![x](https://evil.example/?q=secret) [click](https://evil.example) <img src=x> `code` **bold**\nline", url: "https://shop.example/a(b)|c" })];
    const frame: ResearchFrame = { ...FRAME, rows: [{ key: "x1", label: "Row | [one](https://evil.example)" }] };
    const text = compose({ matrix: matrixOf(frame, records), records });
    const [, , row] = tableOf(text);
    expect(row).toHaveLength(4);
    expect(text).not.toContain("](https://evil.example");
    expect(text).not.toContain("<img");
    expect(text).not.toContain("**bold**");
    expect(text).toContain("(https://shop.example/a%28b%29%7Cc)");
  });

  it("stays within a report's bound at the matrix's limits, and says what it left", () => {
    const longLink = `https://shop.example/${"a".repeat(1_900)}`;
    const criteria = Array.from({ length: RESEARCH_FRAME_LIMITS.criteria }, (_, index) => ({ criterion: `Criterion ${index}`, key: `c${index}`, why: "Why.".repeat(100) }));
    const rows = Array.from({ length: RESEARCH_FRAME_LIMITS.rows }, (_, index) => ({ key: `r${index}`, label: `Row ${index}` }));
    const site = { claim: "c".repeat(2_000), registrableDomain: "shop.example", url: longLink };
    const records = rows.flatMap((row, rowIndex) => criteria.map((criterion, index) => finding(rowIndex * 100 + index + 1, row.key, criterion.key, site)));
    const others = Array.from({ length: 300 }, (_, index) => finding(100_000 + index, "x9", "c1", site));
    const frame: ResearchFrame = { branches: [], changes: [], criteria, rows };
    const all = [...records, ...others, ...Array.from({ length: 164 }, (_, index) => unreachable(200_000 + index, "t".repeat(512), "r".repeat(1_000)))];
    expect(all).toHaveLength(RESEARCH_EVIDENCE_LIMITS.recordsPerRun);
    // Nothing can stop work that never yields: this test's own time limit is what guards it, and it took seconds before `sourceWitnesses`.
    const text = compose({ matrix: matrixOf(frame, all), records: all });
    expect(text.length).toBeLessThanOrEqual(RESEARCH_LIMITS.reportCharacters);
    expect(text).toMatch(/and \d+ more/u);
    expect(text).toContain("No report was handed in");
  });
});

describe("the report port", () => {
  const scope = { now: () => Date.parse("2026-11-02T00:00:00Z"), userMessage: "Проведи исследование." } as ResearchRunScope;
  const parts = (records: readonly ResearchEvidenceRecord[], matrix: ResearchMatrix | null = MATRIX) => ({
    coverage: { ...NOOP_RESEARCH_PORTS.coverage, coverage: async () => matrix?.coverage ?? null, frame: async () => matrix?.frame ?? null },
    evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: vi.fn(async () => records) } });
  const signal = new AbortController().signal;

  it("runs the report check before any other gate of the run", () => {
    expect(createResearchReport(scope, parts([])).gates).toEqual([reportCheckGate]);
  });

  it("builds from the matrix and the records, in English whatever the user wrote in", async () => {
    await expect(createResearchReport(scope, parts(RECORDS)).compose({ ended: "timed_out", signal })).resolves.toContain("Time ran out before a report was written");
  });

  it("is null with no record, and asks the matrix nothing then", async () => {
    const empty = parts([]);
    const frame = vi.spyOn(empty.coverage, "frame");
    await expect(createResearchReport(scope, empty).compose({ ended: "failed", signal })).resolves.toBeNull();
    expect(frame).not.toHaveBeenCalled();
  });

  it("still answers from the records when the matrix cannot be read", async () => {
    const broken = parts(RECORDS);
    broken.coverage.frame = async () => { throw new Error("database down"); };
    await expect(createResearchReport(scope, broken).compose({ ended: "failed", signal })).resolves.toContain("### What was recorded");
  });

  it("lets a failed read of the records go to the run, which logs it and keeps what it has", async () => {
    const broken = parts(RECORDS);
    broken.evidence.records.mockRejectedValue(new Error("database down"));
    await expect(createResearchReport(scope, broken).compose({ ended: "failed", signal })).rejects.toThrow("database down");
  });
});
