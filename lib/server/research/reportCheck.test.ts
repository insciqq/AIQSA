import { describe, expect, it, vi } from "vitest";
import { RESEARCH_ROUND_LIMITS, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFrame, type ResearchPlan } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { runResearchGates, type ResearchAttempt, type ResearchGateContext } from "./gates";
import type { ResearchMatrix } from "./matrix";
import { dataset, DRAFT, finding, FRAME, id, MATRIX, matrixOf, RECORDS, SUMMARY, TABLE, unreachable } from "./report.testFixtures";
import { REPORT_CHECK_GATE, reportCheckGate, researchReportFindings } from "./reportCheck";

const check = (draft: ResearchDraft, records: readonly ResearchEvidenceRecord[] = RECORDS, matrix: ResearchMatrix | null = MATRIX) => researchReportFindings(draft, records, matrix);
const messages = (draft: ResearchDraft, records?: readonly ResearchEvidenceRecord[], matrix?: ResearchMatrix | null) => check(draft, records, matrix).troubles.map(({ message }) => message).join("\n");

const ADVICE: ResearchDraft = { branchPicks: [], doesNotSeparate: null, findings: [], origin: "reserved_call", pickRowKey: null, recordIds: [], report: "Measure the bed first, then try two firmness levels.",
  summary: { rowKeys: [], text: "Measure first." }, unreachable: [] };
/** Three of the fixtures' five pages, so a draft citing all of them can be traced and a test can be about something else. */
const LINKED = "https://maker.example/x1 https://shop.example/x1 https://maker.example/x2";
const withBranches: ResearchFrame ={ ...FRAME, branches: [{ cases: [{ key: "light", label: "до 70 кг" }, { key: "heavy", label: "тяжелее" }], key: "weight", unknown: "Вес спящего" }] };

describe("a draft that holds up", () => {
  it("passes with nothing to say", () => {
    expect(check(DRAFT)).toEqual({ troubles: [] });
  });
});

describe("what the pick rests on", () => {
  it("sends back a pick whose prices and reviews went uncited, as a real run's did, and names the ids to add", () => {
    // The run's store held 56 records and the draft listed 9, all of the maker's specifications.
    const text = messages({ ...DRAFT, recordIds: [id(1)] });
    expect(text).toContain(`x1 / price: ${id(2)}`);
    expect(text).toContain(`x1 / reviews: ${id(3)}`);
    expect(text).not.toContain("x1 / firmness");
    expect(text).toContain("The checks read only what record_ids names");
  });

  it("asks one record of a cell, however many it holds", () => {
    const records = [...RECORDS, finding(6, "x1", "price", { sourceClass: "action_channel", url: "https://shop.example/x1b" })];
    expect(messages({ ...DRAFT, recordIds: [id(1), id(6), id(3)] }, records, matrixOf(FRAME, records))).toBe("");
  });

  it("sends back a pick with no evidence at all", () => {
    const frame = { ...FRAME, rows: [...FRAME.rows, { key: "x3", label: "Askona Trend" }] };
    const text = messages({ ...DRAFT, pickRowKey: "x3" }, RECORDS, matrixOf(frame, RECORDS));
    expect(text).toContain("No record holds evidence for x3");
  });

  it("asks the same of rows called inseparable, since that too is a claim about their data", () => {
    const draft: ResearchDraft = { ...DRAFT, doesNotSeparate: { rowKeys: ["x1", "x2"], statement: "Оба подходят.", wouldDecide: "Полежать на обоих." }, pickRowKey: null, recordIds: [id(1), id(2), id(3), id(4)],
      report: `${DRAFT.report}\n\nОба подходят. Полежать на обоих.\n\n${LINKED}` };
    expect(messages(draft)).toContain(`x2 / price: ${id(5)}`);
    expect(messages({ ...draft, recordIds: [...draft.recordIds!, id(5)] })).toBe("");
  });

  it("never needs a record for a cell nothing filled", () => {
    expect(messages({ ...DRAFT, pickRowKey: "x2", recordIds: [id(4), id(5)], summary: { rowKeys: ["x2"], text: `Берите ${FRAME.rows[1]!.label}.` } })).toBe("");
  });

  it("does not ask a record of a quote that did not check out, which fills no cell", () => {
    const records = [finding(1, "x1", "firmness", { quoteCheck: { reason: null, status: "not_verbatim" } }), ...RECORDS.slice(1)];
    expect(messages({ ...DRAFT, recordIds: [id(2), id(3)] }, records, matrixOf(FRAME, records))).toBe("");
  });
});

describe("what the draft names", () => {
  it("sends back an id that names no record, saying which and what to do", () => {
    const missing = id(99);
    const text = messages({ ...DRAFT, recordIds: [...DRAFT.recordIds!, missing] });
    expect(text).toContain(`These record_ids name no live record of this research: ${missing}`);
    expect(text).toContain("take it out of the report, or record it first");
  });

  it("names an id that was never one, and still reads the rest of the draft", () => {
    const text = messages({ ...DRAFT, recordIds: [...DRAFT.recordIds!, "rec-12"] });
    expect(text).toContain("no live record of this research: rec-12");
    expect(text).not.toContain("Nothing else of this draft was checked.");
  });

  it("sends back references that could not be read, saying what is wrong", () => {
    const { troubles } = check({ ...ADVICE, branchPicks: undefined, doesNotSeparate: undefined, invalidReferences: "pick_row_key must be null or the key of the row picked.", pickRowKey: undefined, recordIds: undefined });
    expect(troubles).toHaveLength(1);
    expect(troubles[0]!.message).toContain("pick_row_key must be null");
    expect(troubles[0]!.message).toContain("Nothing else of this draft was checked.");
  });

  describe("a corrected id", () => {
    const corrected = [...RECORDS.slice(1), finding(7, "x1", "firmness", { supersedes: id(1), url: "https://maker.example/x1" })];

    it("is cited, since the server reads its correction: nothing goes back and no note rests on it", () => {
      expect(check(DRAFT, corrected, matrixOf(FRAME, corrected))).toEqual({ troubles: [] });
    });

    it("cites its correction's link as well", () => {
      expect(check({ ...DRAFT, report: `${DRAFT.report}\n\nhttps://maker.example/x1` }, corrected, matrixOf(FRAME, corrected))).toEqual({ troubles: [] });
    });

    it("does not hide an id of no record beside it", () => {
      const text = messages({ ...DRAFT, recordIds: [...DRAFT.recordIds!, id(99)] }, corrected, matrixOf(FRAME, corrected));
      expect(text).toContain(id(99));
      expect(text).not.toContain(`research: ${id(1)}`);
    });
  });

  it("sends back a pick outside the matrix, and one on a matrix with no rows", () => {
    expect(messages({ ...DRAFT, pickRowKey: "x9" })).toContain("Outside the matrix: row x9. Rows: x1, x2.");
    const noRows = { ...FRAME, rows: [] };
    expect(messages({ ...DRAFT, pickRowKey: "x1" }, RECORDS, matrixOf(noRows, RECORDS))).toContain("The matrix has no rows yet.");
  });

  it("sends back a branch pick and rows called inseparable outside the matrix", () => {
    const frame = withBranches;
    const matrix = matrixOf(frame, RECORDS);
    const picks = [{ branchKey: "weight", caseKey: "light", rowKey: "x1" }, { branchKey: "weight", caseKey: "heavy", rowKey: "x2" }];
    expect(messages({ ...DRAFT, branchPicks: [{ branchKey: "age", caseKey: "young", rowKey: "x1" }] }, RECORDS, matrix)).toContain("branch age");
    expect(messages({ ...DRAFT, branchPicks: [{ branchKey: "weight", caseKey: "tall", rowKey: "x1" }] }, RECORDS, matrix)).toContain("case tall of weight");
    expect(messages({ ...DRAFT, branchPicks: [{ branchKey: "weight", caseKey: "heavy", rowKey: "x9" }] }, RECORDS, matrix)).toContain("row x9");
    expect(messages({ ...DRAFT, branchPicks: [...picks, { branchKey: "weight", caseKey: "light", rowKey: "x2" }] }, RECORDS, matrix)).toContain("case light of weight has two rows");
    expect(messages({ ...DRAFT, doesNotSeparate: { rowKeys: ["x1", "x9"], statement: "Same.", wouldDecide: "Try." } })).toContain("row x9");
  });

  it("asks a pick for every case of what is unknown about the user", () => {
    const matrix = matrixOf(withBranches, RECORDS);
    const light = { branchKey: "weight", caseKey: "light", rowKey: "x1" };
    expect(messages({ ...DRAFT, branchPicks: [light] }, RECORDS, matrix)).toContain("weight/heavy");
    const both = { ...DRAFT, branchPicks: [light, { branchKey: "weight", caseKey: "heavy", rowKey: "x1" }] };
    expect(messages(both, RECORDS, matrix)).toBe("");
  });

  it("takes no branch for granted when the draft picks nothing", () => {
    expect(messages({ ...ADVICE }, RECORDS, matrixOf(withBranches, RECORDS))).toBe("");
  });
});

describe("the summary the reader reads first", () => {
  /** Two more options, so the summary has alternatives to recommend: synthetic, with an offer each in a cell and one outside the matrix. */
  const ladder: ResearchFrame = { ...FRAME, rows: [...FRAME.rows, { key: "kappa", label: "Kappa Firm" }, { key: "sigma", label: "Sigma Duo" }] };
  const ladderRecords = [...RECORDS, finding(11, "kappa", "price", { sourceClass: "action_channel", url: "https://shop.example/kappa" }),
    finding(12, "sigma", null, { sourceClass: "action_channel", url: "https://dealer.example/sigma" }), finding(13, "sigma", "firmness", { url: "https://maker.example/sigma" })];
  const ladderMatrix = matrixOf(ladder, ladderRecords);
  const ladderTable = `${TABLE}\n| Kappa Firm | 20 000 ₽ | нет данных | жёсткая |\n| Sigma Duo | 40 000 ₽ | нет данных | мягкая |`;
  const recommending = (rowKeys: readonly string[], text: string, recordIds = [...DRAFT.recordIds!, id(11), id(12), id(13)]): ResearchDraft =>
    ({ ...DRAFT, recordIds, report: `# Отчёт\n\n${ladderTable}\n\nhttps://maker.example/x1 https://shop.example/x1 https://shop.example/kappa https://maker.example/sigma\n`, summary: { rowKeys, text } });
  const LADDER_TEXT = `Берите ${FRAME.rows[0]!.label} за 30 000 ₽. Дешевле — Kappa Firm за 20 000 ₽; мягче — Sigma Duo за 40 000 ₽.`;

  it("passes with the pick first and each option it lists named in its text", () => {
    expect(messages(recommending(["x1", "kappa", "sigma"], LADDER_TEXT), ladderRecords, ladderMatrix)).toBe("");
  });

  it("sends back a draft without one, picking or not, saying what it holds", () => {
    for (const draft of [{ ...DRAFT, summary: null }, { ...ADVICE, summary: null }]) {
      const text = messages(draft);
      expect(text).toContain("The draft has no summary.");
      expect(text).toContain("two to four short paragraphs");
      expect(text).toContain("the pick first");
    }
  });

  it("sends back a summary that names no row while the draft picks one", () => {
    expect(messages({ ...DRAFT, summary: { rowKeys: [], text: "Берите лучший." } })).toContain("The summary names no row of the matrix while the draft picks x1");
    const inseparable: ResearchDraft = { ...DRAFT, doesNotSeparate: { rowKeys: ["x1", "x2"], statement: "Оба.", wouldDecide: "Полежать." }, pickRowKey: null, summary: { rowKeys: [], text: "Оба." } };
    expect(messages(inseparable)).toContain("while the draft picks x1, x2");
  });

  it("sends back a summary that does not start with the pick, or leaves out a case's pick", () => {
    expect(messages(recommending(["kappa", "x1"], LADDER_TEXT), ladderRecords, ladderMatrix)).toContain("The summary starts with kappa, while pick_row_key is x1");
    const frame: ResearchFrame = { ...ladder, branches: [{ cases: [{ key: "light", label: "до 70 кг" }, { key: "heavy", label: "тяжелее" }], key: "weight", unknown: "Вес" }] };
    const picks = [{ branchKey: "weight", caseKey: "light", rowKey: "x1" }, { branchKey: "weight", caseKey: "heavy", rowKey: "kappa" }];
    const text = messages({ ...recommending(["x1"], LADDER_TEXT), branchPicks: picks }, ladderRecords, matrixOf(frame, ladderRecords));
    expect(text).toContain("The summary leaves out rows branch_picks chooses: kappa");
  });

  it("sends back a text that does not name a row it lists, since the reader sees words, not keys", () => {
    const text = messages(recommending(["x1", "sigma"], `Берите ${FRAME.rows[0]!.label}; есть и мягче.`), ladderRecords, ladderMatrix);
    expect(text).toContain("The summary's text does not name Sigma Duo (sigma)");
    expect(text).not.toContain(`not name ${FRAME.rows[0]!.label}`);
  });

  it("sends back a row it lists that the matrix lacks", () => {
    expect(messages(recommending(["x1", "omega"], LADDER_TEXT), ladderRecords, ladderMatrix)).toContain("Outside the matrix: row omega.");
  });

  it("asks the evidence of every option it recommends, as of a pick, so their prices and sellers reach the checks", () => {
    const text = messages(recommending(["x1", "kappa", "sigma"], LADDER_TEXT, [...DRAFT.recordIds!, id(13)]), ladderRecords, ladderMatrix);
    expect(text).toContain(`kappa / price: ${id(11)}`);
    // An offer the matrix holds in no cell is asked for by itself, once.
    expect(text).toContain(`whose current offers you did not cite: add at least one id of each, so the checks read the price and the seller you state. sigma: ${id(12)}.`);
    expect(text).not.toContain(`kappa: ${id(11)}`);
  });

  it("asks an offer even where another record fills its cell: the cell is cited, the offer is not", () => {
    const records = [...ladderRecords, finding(14, "kappa", "price", { url: "https://maker.example/kappa-price" })];
    const text = messages(recommending(["x1", "kappa", "sigma"], LADDER_TEXT, [...DRAFT.recordIds!, id(12), id(13), id(14)]), records, matrixOf(ladder, records));
    expect(text).toContain(`kappa: ${id(11)}`);
    expect(text).not.toContain("kappa / price");
  });

  it("checks a link in the summary as one in the report: the reader reads both", () => {
    const linked = recommending(["x1", "kappa", "sigma"], `${LADDER_TEXT} Цена: https://elsewhere.example/offer`);
    expect(messages(linked, ladderRecords, ladderMatrix)).toContain("https://elsewhere.example/offer");
  });

  it("sends back what could not be read of it, and keeps what could", () => {
    const text = messages({ ...DRAFT, invalidSummary: "summary.row_keys must list at most 64 keys of the matrix's rows.", summary: { rowKeys: [], text: SUMMARY.text } });
    expect(text).toContain("summary.row_keys must list");
    expect(messages({ ...DRAFT, invalidSummary: "summary.text must be 1 to 4000 characters: two to four short paragraphs.", summary: null })).toContain("summary.text must be");
  });

  it("goes unchecked on rows where the matrix could not be read, but still wants the pick first", () => {
    expect(messages({ ...DRAFT, summary: { rowKeys: ["x1"], text: "Берите лучший." } }, RECORDS, null)).toBe("");
    expect(messages({ ...DRAFT, summary: { rowKeys: ["x2", "x1"], text: SUMMARY.text } }, RECORDS, null)).toContain("The summary starts with x2");
  });
});

describe("the key specifications of the options it recommends", () => {
  /** A matrix whose plan marked the load per side decisive: synthetic, with two sites of the pick's load and one of the reserve's. */
  const KEYED: ResearchFrame = { ...FRAME, criteria: [...FRAME.criteria, { criterion: "Нагрузка на сторону", decisive: true, key: "load", why: "Двое разного веса." }] };
  const load = (number: number, rowKey: string, kg: number, url: string) => finding(number, rowKey, "load", { claim: `Нагрузка на сторону до ${kg} кг.`, url });
  const AGREE = [...RECORDS, load(6, "x1", 130, "https://maker.example/x1-load"), load(7, "x1", 130, "https://shop-b.example/x1")];
  const DISAGREE = [...RECORDS, load(6, "x1", 130, "https://maker.example/x1-load"), load(7, "x1", 140, "https://shop-b.example/x1")];
  const loadTable = (x1: string) => ["| Вариант | Цена за 160×200 | Отзывы владельцев | Жёсткость | Нагрузка на сторону |", "| --- | --- | --- | --- | --- |",
    `| Lonax Memory | 30 000 ₽ | 3 из 11 | средняя | ${x1} |`, "| Optima Classic | 25 000 ₽ | нет данных | жёсткая | нет данных |"].join("\n");
  const keyed = (cited: readonly number[], x1 = "до 130 кг"): ResearchDraft => ({ ...DRAFT, recordIds: [...DRAFT.recordIds!, ...cited.map(id)],
    report: `# Отчёт\n\nБерите Lonax Memory.\n\n${loadTable(x1)}\n\nhttps://maker.example/x1 https://shop.example/x1 https://shop.example/3\n` });
  const keyedMessages = (draft: ResearchDraft, records: readonly ResearchEvidenceRecord[]) => messages(draft, records, matrixOf(KEYED, records));

  it("passes a pick whose key specification two sites hold and the draft cites from both", () => {
    expect(keyedMessages(keyed([6, 7]), AGREE)).toBe("");
  });

  it("asks a record of the second site where the draft cites one, so the checks read both", () => {
    const text = keyedMessages(keyed([6]), AGREE);
    expect(text).toContain(`cite records of two sites for each of these, from the ids of sites you do not cite yet. x1 / load: ${id(7)}.`);
  });

  it("asks both of two disagreeing sites to be cited, and the report to name the disagreement for that option", () => {
    expect(keyedMessages(keyed([6]), DISAGREE)).toContain(`Two sites give different figures for a key specification of an option you recommend: cite both records, so the checks read both, and name ` +
      `the disagreement in the report. x1 / load: ${id(6)}, ${id(7)}.`);
    expect(keyedMessages(keyed([6, 7]), DISAGREE)).toContain("Two sites disagree on a key specification of an option you recommend, and the report does not state both figures: name the " +
      "disagreement for that option, each figure with the site that gives it, instead of one figure. Lonax Memory — Нагрузка на сторону: 130 кг (maker.example) against 140 кг (shop-b.example).");
    expect(keyedMessages(keyed([6, 7], "130 кг у производителя, 140 кг у продавца"), DISAGREE)).toBe("");
  });

  it("asks nothing of an option the draft does not recommend, nor of two pages of one site", () => {
    const reserve = [...AGREE, load(8, "x2", 120, "https://maker.example/x2-load"), load(9, "x2", 150, "https://shop-c.example/x2")];
    expect(keyedMessages(keyed([6, 7]), reserve)).toBe("");
    const oneSite = [...RECORDS, load(6, "x1", 130, "https://maker.example/x1-load"), load(7, "x1", 140, "https://maker.example/x1-spec")];
    expect(keyedMessages(keyed([6]), oneSite)).toBe("");
  });

  it("reads no key specification in a frame that marks none, as every frame stored before did", () => {
    expect(messages(keyed([6]), DISAGREE, matrixOf({ ...KEYED, criteria: [...FRAME.criteria, { criterion: "Нагрузка на сторону", key: "load", why: "Двое разного веса." }] }, DISAGREE))).toBe("");
  });
});

describe("advice without facts", () => {
  it("passes: it names no pick and cites no record, however much the store holds", () => {
    expect(check(ADVICE)).toEqual({ troubles: [] });
  });

  it("passes on a matrix that holds nothing yet", () => {
    expect(check(ADVICE, [], matrixOf(FRAME, []))).toEqual({ troubles: [] });
  });

  it("goes back as soon as it links a source, which is a claim to rest on it", () => {
    expect(messages({ ...ADVICE, report: "See https://elsewhere.example/guide for how to choose." })).toContain("no record of this research");
  });
});

describe("the report's links", () => {
  const linked = (...links: readonly string[]) => ({ ...DRAFT, report: `${DRAFT.report}\n\n${links.join(" ")}` });

  it("sends back a link of a record the draft did not cite, with the id to add", () => {
    const text = messages(linked("[магазин](https://shop.example/x2)."));
    expect(text).toContain(`https://shop.example/x2 (record ${id(5)})`);
    expect(text).toContain("add their ids");
  });

  it("sends back a link that is no record at all", () => {
    const text = messages(linked("https://elsewhere.example/page"));
    expect(text).toContain("no record of this research");
  });

  it("reads a link as its page, whatever surrounds or follows it", () => {
    expect(messages(linked("[a](https://maker.example/x1)", "**https://www.maker.example/x1/**", "(https://shop.example/x1?utm_source=x#buy),", "https://maker.example/x1."))).toBe("");
  });

  it("keeps a bracket a link opened", () => {
    const records = [...RECORDS, finding(6, "x2", "reviews", { url: "https://wiki.example/Mattress_(bed)" })];
    expect(messages({ ...linked("[вики](https://wiki.example/Mattress_(bed))", "https://maker.example/x1"), recordIds: [...DRAFT.recordIds!, id(6)] }, records, matrixOf(FRAME, records))).toBe("");
  });

  it("counts a dataset's examples and its own link", () => {
    expect(messages(linked("https://shop.example/x1/reviews", "https://shop.example/3"))).toBe("");
  });

  it("lets a link to a site's root pass with a record cited on that site: it says nothing and backs nothing", () => {
    expect(messages(linked("https://maker.example/", "https://www.maker.example", "[сайт](https://maker.example)."))).toBe("");
  });

  it("lets through a site's root only, and only with a record cited there", () => {
    expect(messages(linked("https://maker.example/other-page"))).toContain("https://maker.example/other-page");
    expect(messages(linked("https://maker.example/?page=2"))).toContain("https://maker.example/?page=2");
    expect(messages(linked("https://elsewhere.example/"))).toContain("https://elsewhere.example/");
    expect(messages({ ...linked("https://maker.example/"), recordIds: [id(2), id(3)] })).toContain("https://maker.example/");
  });

  it("lets a report link what could not be reached", () => {
    const records = [...RECORDS, unreachable(6, "https://www.ozon.ru", "Blocked.")];
    expect(messages(linked("https://www.ozon.ru"), records, matrixOf(FRAME, records))).toBe("");
    expect(messages({ ...linked("https://blocked.example/"), unreachable: [{ reason: "Blocked.", sourceClass: null, target: "https://blocked.example" }] })).toBe("");
  });
});

describe("what a reader can trace", () => {
  const onPages = (pages: number) => Array.from({ length: pages }, (_, index) => finding(index + 1, "x1", "price", { claim: `Claim about page ${index + 1}.`, url: `https://source.example/${index + 1}` }));
  const draftOn = (records: readonly ResearchEvidenceRecord[], report: string): ResearchDraft => ({ ...ADVICE, recordIds: records.map(({ id: recordId }) => recordId), report });
  const linking = (linked: number) => `Отчёт.\n\n${Array.from({ length: linked }, (_, index) => `[источник](https://source.example/${index + 1})`).join(" ")}`;
  const traced = (pages: number, linked: number) => messages(draftOn(onPages(pages), linking(linked)), onPages(pages), null);

  it.each([[4, 1, "1 of the 4"], [4, 0, "0 of the 4"], [5, 2, "2 of the 5"], [30, 2, "2 of the 30"]])("sends back %i pages with %i linked: fewer than half", (pages, linked, words) => {
    expect(traced(pages, linked)).toContain(`The report links ${words} pages it rests on`);
  });

  it.each([[4, 2], [4, 4], [5, 3], [6, 3]])("passes %i pages with %i linked: half or more", (pages, linked) => {
    expect(traced(pages, linked)).toBe("");
  });

  it.each([[3, 0], [3, 1], [1, 0]])("wants no link count of %i pages with %i linked: under 4 there is too little to tell by", (pages, linked) => {
    expect(traced(pages, linked)).toBe("");
  });

  it("counts pages, not records, so many records on three pages stay under the line", () => {
    const records = Array.from({ length: 12 }, (_, index) => finding(index + 1, "x1", "price", { url: `https://source.example/${index % 3}` }));
    expect(messages(draftOn(records, "Отчёт."), records, null)).toBe("");
  });

  it("reads a tracking query as the same page", () => {
    const records = onPages(4).map((record, index) => index < 2 ? { ...record, url: `https://source.example/${index + 1}?utm_source=mail` } as ResearchEvidenceRecord : record);
    expect(messages(draftOn(records, linking(2)), records, null)).toBe("");
  });

  it("counts a page linked from a list at the end: the reader can reach it", () => {
    const list = ["https://source.example/1", "https://source.example/2"].map((link) => `- ${link}`).join("\n");
    expect(messages(draftOn(onPages(4), `Отчёт.\n\n## Источники\n${list}`), onPages(4), null)).toBe("");
  });

  it("counts a link to a dataset's example as reaching that record", () => {
    const records = [dataset(1, "x1", "reviews"), ...onPages(5).slice(1)];
    expect(messages(draftOn(records, `${linking(0)} https://shop.example/x1/reviews https://source.example/2 https://source.example/3`), records, null)).toBe("");
  });

  it("does not take a link to a site's root for a page", () => {
    const records = onPages(4);
    expect(messages(draftOn(records, "Отчёт: https://source.example/"), records, null)).toContain("0 of the 4");
  });

  it("does not count a page no cited record stands on", () => {
    const records = onPages(4);
    expect(messages(draftOn(records, `${linking(1)} https://elsewhere.example/page`), records, null)).toContain("1 of the 4");
  });

  it("lists the pages it does not link with their claims in a few words, and never those it does", () => {
    const records = [...onPages(4), finding(5, "x1", "reviews", { claim: "Another claim on page four.", url: "https://source.example/4" })];
    const text = messages(draftOn(records, linking(1)), records, null);
    expect(text).toContain("https://source.example/2 (Claim about page 2.)");
    expect(text).toContain("https://source.example/4 (Claim about page 4., and 1 more)");
    expect(text).not.toContain("https://source.example/1 ");
  });

  it("keeps its list as short as the others, and each claim to a few words", () => {
    const records = Array.from({ length: 30 }, (_, index) => finding(index + 1, "x1", "price", { claim: "c".repeat(500), url: `https://source.example/${index + 1}` }));
    const text = messages(draftOn(records, "Отчёт."), records, null);
    expect(text).toContain("and 6 more");
    expect(text).not.toContain("c".repeat(100));
  });

  it("reads a corrected id as its correction's page", () => {
    const records = [...onPages(4).slice(1), finding(7, "x1", "price", { supersedes: id(1), url: "https://source.example/1" })];
    expect(messages({ ...draftOn(records, linking(2)), recordIds: [id(1), id(2), id(3), id(4)] }, records, null)).toBe("");
  });

  it("leaves a text draft alone, which has no ids", () => {
    expect(check({ findings: [], origin: "plain_text", report: "Отчёт.", unreachable: [] }, onPages(5), null)).toEqual({ troubles: [] });
  });
});

describe("the comparison", () => {
  const without = (table: string) => ({ ...DRAFT, report: `# Отчёт\n\nБерите Lonax Memory.\n\n${table}` });

  it("sends back a draft with no table where rows have evidence to compare", () => {
    expect(messages({ ...DRAFT, report: "# Отчёт\n\nБерите Lonax Memory." })).toContain("The report has no comparison table.");
    expect(messages({ ...DRAFT, report: "Лонакс | Оптима" })).toContain("has no comparison table");
    expect(messages({ ...DRAFT, report: "Lonax | Optima" })).toContain("has no comparison table");
  });

  it("wants no table from one row or none, where nothing compares", () => {
    const frame = { ...FRAME, rows: FRAME.rows.slice(0, 1) };
    const records = RECORDS.slice(0, 3);
    expect(messages({ ...DRAFT, report: "Lonax Memory." }, records, matrixOf(frame, records))).toBe("");
    const knowledge = { ...FRAME, rows: [] };
    expect(messages({ ...DRAFT, pickRowKey: null, report: "An answer.", summary: { rowKeys: [], text: "The answer in short." } }, RECORDS, matrixOf(knowledge, RECORDS))).toBe("");
  });

  it("names the criteria a table leaves out, with why they matter", () => {
    const table = ["| Вариант | Цена за 160×200 | Отзывы владельцев |", "| --- | --- | --- |", "| Lonax Memory | 30 000 ₽ | 3 из 11 |"].join("\n");
    const text = messages(without(table));
    expect(text).toContain("Жёсткость (От неё зависит спина.)");
    expect(messages(without(table))).toContain("Жёсткость");
  });

  it("takes a shortened heading, another case of a word and a table on its side", () => {
    const short = ["| Вариант | Цены | Отзывы | Жесткости |", "|:---|---:|---|---|", "| Lonax Memory | 30 000 ₽ | 3 из 11 | средняя |"].join("\n");
    expect(messages(without(short))).toBe("");
    const turned = ["| | Lonax Memory | Optima Classic |", "| --- | --- | --- |", "| Цена за 160×200 | 30 000 ₽ | 25 000 ₽ |", "| Отзывы | 3 из 11 | нет данных |", "| Жёсткость | средняя | жёсткая |"].join("\n");
    expect(messages(without(turned))).toBe("");
  });

  describe("a criterion in another script than the report's", () => {
    const ENGLISH = "Independent test results for a specific candidate model";
    /** A summary is in the report's language. */
    const inEnglish = (report: string): ResearchDraft => ({ ...DRAFT, report, summary: { ...SUMMARY, text: `Take ${FRAME.rows[0]!.label}.` } });
    const added = (criterion: string): ResearchFrame => ({ ...FRAME, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_criterion", key: "tests", reason: "It separates the rows." }],
      criteria: [...FRAME.criteria, { criterion, key: "tests", why: "It separates the rows." }] });

    it("passes, added or not: no word match can see a translation, and a real run's model pasted the English in to get past it", () => {
      expect(check(DRAFT, RECORDS, matrixOf(added(ENGLISH), RECORDS))).toEqual({ troubles: [] });
    });

    it("passes the other way round", () => {
      const english = "# Report\n\n| Option | Price | Reviews | Firmness |\n| --- | --- | --- | --- |\n| Lonax Memory | 30 000 | 3 of 11 | medium |\n| Optima Classic | 25 000 | none | firm |\n";
      expect(messages(inEnglish(english), RECORDS, matrixOf(added("Шумность"), RECORDS))).toBe("");
    });

    it("still goes back in the report's own script", () => {
      expect(messages(DRAFT, RECORDS, matrixOf(added("Шумность"), RECORDS))).toContain("Шумность");
    });

    it("still goes back for an English criterion an English report leaves out", () => {
      const frame = added("Noise level");
      const english = "# Report\n\n| Option | Price |\n| --- | --- |\n| Lonax Memory | 30 000 |\n| Optima Classic | 25 000 |\n";
      expect(messages(inEnglish(english), RECORDS, matrixOf({ ...frame, criteria: frame.criteria.slice(3) }, RECORDS))).toContain("Noise level");
    });

    it("is about criteria only: a row's name is not translated, so a Latin name stays wanted in a Russian table", () => {
      const table = ["| Вариант | Цена за 160×200 | Отзывы владельцев | Жёсткость |", "| --- | --- | --- | --- |", "| Optima Classic | 25 000 ₽ | нет данных | жёсткая |"].join("\n");
      expect(messages({ ...DRAFT, report: `# Отчёт\n\n${table}` })).toContain("leaves out what you pick: Lonax Memory");
    });
  });

  describe("a criterion of one word", () => {
    const frameOf = (criterion: string): ResearchFrame => ({ ...FRAME, criteria: [{ criterion, key: "price", why: "Мешает спать." }] });
    const table = (heading: string) => [`| Вариант | ${heading} |`, "| --- | --- |", "| Lonax Memory | 30 дБ |", "| Optima Classic | 40 дБ |"].join("\n");
    const onHeading = (criterion: string, heading: string) => messages(without(table(heading)), RECORDS, matrixOf(frameOf(criterion), RECORDS));

    it("is found by its root under a shortened heading", () => {
      expect(onHeading("Шумность", "Шум, дБ")).toBe("");
    });

    it("still goes back when no heading holds its root", () => {
      expect(onHeading("Шумность", "Цена")).toContain("Шумность");
    });

    it("leaves a label of many words to the rule it had: any of its words", () => {
      expect(onHeading("Уровень шумности", "Шум, дБ")).toContain("Уровень шумности");
      expect(onHeading("Уровень шумности", "Шумности")).toBe("");
    });
  });

  it("wants what is picked in the table", () => {
    const table = ["| Вариант | Цена за 160×200 | Отзывы владельцев | Жёсткость |", "| --- | --- | --- | --- |", "| Optima Classic | 25 000 ₽ | нет данных | жёсткая |"].join("\n");
    expect(messages(without(table))).toContain("leaves out what you pick: Lonax Memory");
  });

  it("does not take a horizontal rule or a stray bar for a table", () => {
    expect(messages({ ...DRAFT, report: "Lonax | Optima\n---\nNothing else." })).toContain("no comparison table");
  });

  it("asks an added criterion to be named with its reason", () => {
    const frame: ResearchFrame = { ...FRAME, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_criterion", key: "smell", reason: "Покупатели жалуются на запах." }],
      criteria: [...FRAME.criteria, { criterion: "Запах", key: "smell", why: "Мешает спать." }] };
    const matrix = matrixOf(frame, RECORDS);
    const table = (extra: string, cell: string) => DRAFT.report.replace("| Жёсткость |", `| Жёсткость |${extra}`).replace("| средняя |", `| средняя |${cell}`).replace("| --- | --- | --- | --- |", "| --- | --- | --- | --- | --- |");
    expect(messages(DRAFT, RECORDS, matrix)).toContain("Запах (Покупатели жалуются на запах.)");
    expect(messages(DRAFT, RECORDS, matrix)).toContain("Запах (Покупатели жалуются на запах.)");
    expect(messages({ ...DRAFT, report: `${table(" Запах |", " нет |")}\n\nЗапах добавлен: покупатели жалуются.` }, RECORDS, matrix)).toBe("");
  });
});

describe("when the data does not separate", () => {
  const stated = { rowKeys: ["x1", "x2"], statement: "Данные не разделяют эти матрасы.", wouldDecide: "Полежать на обоих в салоне." };
  const draft: ResearchDraft = { ...DRAFT, doesNotSeparate: stated, pickRowKey: null, recordIds: [id(1), id(2), id(3), id(4), id(5)], report: `${DRAFT.report}\n\n${LINKED}` };

  it("leaves saying so to the report: nothing goes back, and the server adds nothing whether the report says it or not", () => {
    expect(check(draft)).toEqual({ troubles: [] });
    expect(check({ ...draft, report: `${draft.report}\n\n${stated.statement}   ${stated.wouldDecide}` })).toEqual({ troubles: [] });
  });
});

describe("what it leaves alone", () => {
  it("passes a text draft as it stands: it has no ids", () => {
    expect(check({ findings: [], origin: "plain_text", report: "See https://elsewhere.example/page.", unreachable: [] })).toEqual({ troubles: [] });
  });

  it("passes a run with no frame and no records, which goes on as it always did", () => {
    const stored = { findings: [{ claim: "It holds.", quote: "It holds.", sourceClass: "independent_tests" as const, standing: "confirmed" as const, url: "https://lab.example/x" }],
      origin: "reserved_call" as const, report: "It holds.", unreachable: [] };
    expect(check(stored, [], null)).toEqual({ troubles: [] });
  });

  it("still checks ids where only the matrix could not be read", () => {
    expect(messages({ ...DRAFT, recordIds: [id(99)] }, RECORDS, null)).toContain(id(99));
    expect(messages({ ...DRAFT, pickRowKey: "x9", summary: { ...SUMMARY, rowKeys: ["x9"] } }, RECORDS, null)).toBe("");
  });
});

describe("a model that still types its findings", () => {
  it("goes back with what to pass instead, in place of every other complaint", () => {
    const typed: ResearchDraft = { findings: [{ claim: "Typed.", quote: "Typed.", sourceClass: "owner_reviews", standing: "confirmed", url: "https://elsewhere.example/page" }],
      origin: "reserved_call", report: "Typed, with https://elsewhere.example/page.", unreachable: [] };
    const { troubles } = check(typed);
    expect(troubles).toHaveLength(1);
    expect(troubles[0]!.message).toContain("Pass record_ids");
  });
});

describe("the gate", () => {
  const plan: ResearchPlan = { goal: "Выбрать матрас.", questions: [{ question: "Какой?", sites: [], sourceClasses: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }], skipped: [] };
  const context = (records: () => Promise<readonly ResearchEvidenceRecord[]>, earlier: readonly ResearchAttempt[] = [], matrix = MATRIX): ResearchGateContext => ({ attempt: earlier.length + 1,
    coverage: { change: vi.fn(), coverage: async () => matrix.coverage, frame: async () => matrix.frame }, earlier, evidence: { page: vi.fn(), record: vi.fn(), records }, plan,
    signal: new AbortController().signal, sources: { opened: async () => [] }, subagents: { run: vi.fn() }, time: { remainingMs: () => 600_000, sendBackAllowed: () => true }, verifierModel: vi.fn() });
  const run = (draft: ResearchDraft, earlier: readonly ResearchAttempt[] = [], records = async () => RECORDS) =>
    runResearchGates({ context: context(records, earlier), draft, gates: [reportCheckGate], runId: "run-1" });

  it("accepts a draft that holds up", async () => {
    await expect(run(DRAFT)).resolves.toEqual({ kind: "accepted", notes: [] });
  });

  it("sends a draft back under its own name, and leaves nothing of it for the answer", async () => {
    const outcome = await run({ ...DRAFT, pickRowKey: "x9" });
    expect(outcome).toEqual({ gate: REPORT_CHECK_GATE, kind: "sent_back", message: expect.stringContaining("Outside the matrix") });
  });

  it("stops sending back at the cap, and the answer says nothing of what its form missed", async () => {
    const earlier = Array.from({ length: RESEARCH_ROUND_LIMITS.sendBacksPerCheck }, () => ({ draft: DRAFT, gate: REPORT_CHECK_GATE, message: "Again." }));
    expect(await run({ ...DRAFT, pickRowKey: "x9" }, earlier)).toEqual({ kind: "accepted", notes: [] });
  });

  it("costs its check and leaves a note when the store cannot be read, never the answer", async () => {
    const outcome = await run(DRAFT, [], async () => { throw new Error("database down"); });
    expect(outcome.kind).toBe("accepted");
    expect(outcome.notes?.join("\n")).toContain("could not be completed");
  });

  it("reads no store for a text draft", async () => {
    const records = vi.fn(async () => RECORDS);
    await runResearchGates({ context: context(records), draft: { findings: [], origin: "plain_text", report: "Text.", unreachable: [] }, gates: [reportCheckGate], runId: "run-1" });
    expect(records).not.toHaveBeenCalled();
  });

  it("keeps a send back to the bound on a follow-up, every kind of trouble represented", async () => {
    const many = Array.from({ length: 300 }, (_, index) => id(1_000 + index));
    const links = Array.from({ length: 300 }, (_, index) => `https://elsewhere.example/${"page".repeat(40)}/${index}`).join("\n");
    const outcome = await run({ ...DRAFT, pickRowKey: "x9", recordIds: many, report: links });
    if (outcome.kind !== "sent_back") throw new Error("expected a send back");
    expect(outcome.message.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    for (const part of ["These record_ids name no live record", "Outside the matrix", "no comparison table"]) expect(outcome.message).toContain(part);
    expect(outcome.message).toContain("and 276 more");
  });

  it("reads a dataset's cell like any other", () => {
    const records = [dataset(1, "x1", "reviews")];
    const frame = { ...FRAME, criteria: FRAME.criteria.slice(1, 2), rows: FRAME.rows.slice(0, 1) };
    expect(messages({ ...DRAFT, recordIds: [id(1)], report: "Lonax Memory." }, records, matrixOf(frame, records))).toBe("");
  });
});
