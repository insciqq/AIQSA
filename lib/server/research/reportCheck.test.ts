import { describe, expect, it, vi } from "vitest";
import { RESEARCH_ROUND_LIMITS, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFrame, type ResearchPlan } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { runResearchGates, type ResearchAttempt, type ResearchGateContext } from "./gates";
import type { ResearchMatrix } from "./matrix";
import { dataset, DRAFT, finding, FRAME, id, MATRIX, matrixOf, RECORDS, TABLE, unreachable } from "./report.testFixtures";
import { REPORT_CHECK_GATE, reportCheckGate, researchReportFindings } from "./reportCheck";

const check = (draft: ResearchDraft, records: readonly ResearchEvidenceRecord[] = RECORDS, matrix: ResearchMatrix | null = MATRIX) => researchReportFindings(draft, records, matrix);
const messages = (draft: ResearchDraft, records?: readonly ResearchEvidenceRecord[], matrix?: ResearchMatrix | null) => check(draft, records, matrix).troubles.map(({ message }) => message).join("\n");
const said = (draft: ResearchDraft, records?: readonly ResearchEvidenceRecord[], matrix?: ResearchMatrix | null) => check(draft, records, matrix).troubles.map(({ note }) => note).join("\n");

const ADVICE: ResearchDraft = { branchPicks: [], doesNotSeparate: null, findings: [], origin: "reserved_call", pickRowKey: null, recordIds: [], report: "Measure the bed first, then try two firmness levels.", unreachable: [] };
const withBranches: ResearchFrame = { ...FRAME, branches: [{ cases: [{ key: "light", label: "до 70 кг" }, { key: "heavy", label: "тяжелее" }], key: "weight", unknown: "Вес спящего" }] };

describe("a draft that holds up", () => {
  it("passes with nothing to say", () => {
    expect(check(DRAFT)).toEqual({ notes: [], troubles: [] });
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
    expect(said({ ...DRAFT, recordIds: [id(1)] })).toContain("Lonax Memory: Цена за 160×200");
  });

  it("asks one record of a cell, however many it holds", () => {
    const records = [...RECORDS, finding(6, "x1", "price", { url: "https://shop.example/x1b" })];
    expect(messages({ ...DRAFT, recordIds: [id(1), id(6), id(3)] }, records, matrixOf(FRAME, records))).toBe("");
  });

  it("sends back a pick with no evidence at all", () => {
    const frame = { ...FRAME, rows: [...FRAME.rows, { key: "x3", label: "Askona Trend" }] };
    const text = messages({ ...DRAFT, pickRowKey: "x3" }, RECORDS, matrixOf(frame, RECORDS));
    expect(text).toContain("No record holds evidence for x3");
  });

  it("asks the same of rows called inseparable, since that too is a claim about their data", () => {
    const draft: ResearchDraft = { ...DRAFT, doesNotSeparate: { rowKeys: ["x1", "x2"], statement: "Оба подходят.", wouldDecide: "Полежать на обоих." }, pickRowKey: null, recordIds: [id(1), id(2), id(3), id(4)],
      report: `${DRAFT.report}\n\nОба подходят. Полежать на обоих.` };
    expect(messages(draft)).toContain(`x2 / price: ${id(5)}`);
    expect(messages({ ...draft, recordIds: [...draft.recordIds!, id(5)] })).toBe("");
  });

  it("never needs a record for a cell nothing filled", () => {
    expect(messages({ ...DRAFT, pickRowKey: "x2", recordIds: [id(4), id(5)] })).toBe("");
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

  it("says references could not be read, never that records do not stand, in the report's language", () => {
    const unreadable: ResearchDraft = { ...ADVICE, invalidReferences: "pick_row_key must be null or the key of the row picked.", pickRowKey: undefined, recordIds: undefined };
    expect(said(unreadable)).toBe("The references of this report could not be read, so the checks did not read the records behind it.");
    expect(said({ ...unreadable, report: "Отчёт." })).toBe("Ссылки этого отчёта на записи исследования не удалось прочитать, поэтому проверки не читали записи, на которых он стоит.");
  });

  describe("a corrected id", () => {
    const corrected = [...RECORDS.slice(1), finding(7, "x1", "firmness", { supersedes: id(1), url: "https://maker.example/x1" })];

    it("is cited, since the server reads its correction: nothing goes back and no note rests on it", () => {
      expect(check(DRAFT, corrected, matrixOf(FRAME, corrected))).toEqual({ notes: [], troubles: [] });
    });

    it("cites its correction's link as well", () => {
      expect(check({ ...DRAFT, report: `${DRAFT.report}\n\nhttps://maker.example/x1` }, corrected, matrixOf(FRAME, corrected))).toEqual({ notes: [], troubles: [] });
    });

    it("does not hide an id of no record beside it", () => {
      const text = messages({ ...DRAFT, recordIds: [...DRAFT.recordIds!, id(99)] }, corrected, matrixOf(FRAME, corrected));
      expect(text).toContain(id(99));
      expect(text).not.toContain(`research: ${id(1)}`);
    });
  });

  it("sends back a pick outside the matrix, and one on a matrix with no rows", () => {
    expect(messages({ ...DRAFT, pickRowKey: "x9" })).toContain("Outside the matrix: row x9. Rows: x1, x2.");
    expect(said({ ...DRAFT, pickRowKey: "x9" })).toContain("не входит в варианты");
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
    expect(said({ ...DRAFT, branchPicks: [light] }, RECORDS, matrix)).toContain("Вес спящего: тяжелее");
    const both = { ...DRAFT, branchPicks: [light, { branchKey: "weight", caseKey: "heavy", rowKey: "x1" }] };
    expect(messages(both, RECORDS, matrix)).toBe("");
  });

  it("takes no branch for granted when the draft picks nothing", () => {
    expect(messages({ ...ADVICE }, RECORDS, matrixOf(withBranches, RECORDS))).toBe("");
  });
});

describe("advice without facts", () => {
  it("passes: it names no pick and cites no record, however much the store holds", () => {
    expect(check(ADVICE)).toEqual({ notes: [], troubles: [] });
  });

  it("passes on a matrix that holds nothing yet", () => {
    expect(check(ADVICE, [], matrixOf(FRAME, []))).toEqual({ notes: [], troubles: [] });
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
    expect(said(linked("https://elsewhere.example/page"))).toContain("ссылками");
  });

  it("reads a link as its page, whatever surrounds or follows it", () => {
    expect(messages(linked("[a](https://maker.example/x1)", "**https://www.maker.example/x1/**", "(https://shop.example/x1?utm_source=x#buy),", "https://maker.example/x1."))).toBe("");
  });

  it("keeps a bracket a link opened", () => {
    const records = [...RECORDS, finding(6, "x2", "reviews", { url: "https://wiki.example/Mattress_(bed)" })];
    expect(messages({ ...linked("[вики](https://wiki.example/Mattress_(bed))"), recordIds: [...DRAFT.recordIds!, id(6)] }, records, matrixOf(FRAME, records))).toBe("");
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

describe("the comparison", () => {
  const without = (table: string) => ({ ...DRAFT, report: `# Отчёт\n\nБерите Lonax Memory.\n\n${table}` });

  it("sends back a draft with no table where rows have evidence to compare", () => {
    expect(messages({ ...DRAFT, report: "# Отчёт\n\nБерите Lonax Memory." })).toContain("The report has no comparison table.");
    expect(said({ ...DRAFT, report: "Лонакс | Оптима" })).toContain("нет таблицы сравнения");
    expect(said({ ...DRAFT, report: "Lonax | Optima" })).toContain("has no comparison table");
  });

  it("wants no table from one row or none, where nothing compares", () => {
    const frame = { ...FRAME, rows: FRAME.rows.slice(0, 1) };
    const records = RECORDS.slice(0, 3);
    expect(messages({ ...DRAFT, report: "Lonax Memory." }, records, matrixOf(frame, records))).toBe("");
    const knowledge = { ...FRAME, rows: [] };
    expect(messages({ ...DRAFT, pickRowKey: null, report: "An answer." }, RECORDS, matrixOf(knowledge, RECORDS))).toBe("");
  });

  it("names the criteria a table leaves out, with why they matter", () => {
    const table = ["| Вариант | Цена за 160×200 | Отзывы владельцев |", "| --- | --- | --- |", "| Lonax Memory | 30 000 ₽ | 3 из 11 |"].join("\n");
    const text = messages(without(table));
    expect(text).toContain("Жёсткость (От неё зависит спина.)");
    expect(said(without(table))).toContain("Жёсткость");
  });

  it("takes a shortened heading, another case of a word and a table on its side", () => {
    const short = ["| Вариант | Цены | Отзывы | Жесткости |", "|:---|---:|---|---|", "| Lonax Memory | 30 000 ₽ | 3 из 11 | средняя |"].join("\n");
    expect(messages(without(short))).toBe("");
    const turned = ["| | Lonax Memory | Optima Classic |", "| --- | --- | --- |", "| Цена за 160×200 | 30 000 ₽ | 25 000 ₽ |", "| Отзывы | 3 из 11 | нет данных |", "| Жёсткость | средняя | жёсткая |"].join("\n");
    expect(messages(without(turned))).toBe("");
  });

  describe("a criterion in another script than the report's", () => {
    const ENGLISH = "Independent test results for a specific candidate model";
    const added = (criterion: string): ResearchFrame => ({ ...FRAME, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_criterion", key: "tests", reason: "It separates the rows." }],
      criteria: [...FRAME.criteria, { criterion, key: "tests", why: "It separates the rows." }] });

    it("passes, added or not: no word match can see a translation, and a real run's model pasted the English in to get past it", () => {
      expect(check(DRAFT, RECORDS, matrixOf(added(ENGLISH), RECORDS))).toEqual({ notes: [], troubles: [] });
    });

    it("passes the other way round", () => {
      const english = "# Report\n\n| Option | Price | Reviews | Firmness |\n| --- | --- | --- | --- |\n| Lonax Memory | 30 000 | 3 of 11 | medium |\n| Optima Classic | 25 000 | none | firm |\n";
      expect(messages({ ...DRAFT, report: english }, RECORDS, matrixOf(added("Шумность"), RECORDS))).toBe("");
    });

    it("still goes back in the report's own script", () => {
      expect(messages(DRAFT, RECORDS, matrixOf(added("Шумность"), RECORDS))).toContain("Шумность");
    });

    it("still goes back for an English criterion an English report leaves out", () => {
      const frame = added("Noise level");
      const english = "# Report\n\n| Option | Price |\n| --- | --- |\n| Lonax Memory | 30 000 |\n| Optima Classic | 25 000 |\n";
      expect(messages({ ...DRAFT, report: english }, RECORDS, matrixOf({ ...frame, criteria: frame.criteria.slice(3) }, RECORDS))).toContain("Noise level");
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

  it("asks an added criterion to be named, and its reason reaches the answer if it never is", () => {
    const frame: ResearchFrame = { ...FRAME, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_criterion", key: "smell", reason: "Покупатели жалуются на запах." }],
      criteria: [...FRAME.criteria, { criterion: "Запах", key: "smell", why: "Мешает спать." }] };
    const matrix = matrixOf(frame, RECORDS);
    const table = (extra: string, cell: string) => DRAFT.report.replace("| Жёсткость |", `| Жёсткость |${extra}`).replace("| средняя |", `| средняя |${cell}`).replace("| --- | --- | --- | --- |", "| --- | --- | --- | --- | --- |");
    expect(messages(DRAFT, RECORDS, matrix)).toContain("Запах (Покупатели жалуются на запах.)");
    expect(said(DRAFT, RECORDS, matrix)).toContain("Запах: Покупатели жалуются на запах.");
    expect(messages({ ...DRAFT, report: `${table(" Запах |", " нет |")}\n\nЗапах добавлен: покупатели жалуются.` }, RECORDS, matrix)).toBe("");
  });
});

describe("when the data does not separate", () => {
  const stated = { rowKeys: ["x1", "x2"], statement: "Данные не разделяют эти матрасы.", wouldDecide: "Полежать на обоих в салоне." };
  const draft: ResearchDraft = { ...DRAFT, doesNotSeparate: stated, pickRowKey: null, recordIds: [id(1), id(2), id(3), id(4), id(5)] };

  it("reaches the user in the server's note when the report does not say it, with no rewrite", () => {
    const { notes, troubles } = check(draft);
    expect(troubles).toEqual([]);
    expect(notes).toEqual(["Данные не разделяют эти варианты: Lonax Memory, Optima Classic. Данные не разделяют эти матрасы. Что решит: Полежать на обоих в салоне."]);
  });

  it("adds nothing when the report says it", () => {
    expect(check({ ...draft, report: `${draft.report}\n\n${stated.statement}   ${stated.wouldDecide}` }).notes).toEqual([]);
  });

  it("lets nothing a model wrote become a link or an image in the answer", () => {
    const { notes } = check({ ...draft, doesNotSeparate: { ...stated, statement: "Оба ![x](https://evil.example/?q=1) хороши.", wouldDecide: "[Жмите](https://evil.example)." } });
    expect(notes.join("")).not.toContain("](");
    expect(notes.join("")).not.toContain("![");
  });

  it("speaks the report's language and leaves it a plain note", () => {
    const { notes } = check({ ...draft, doesNotSeparate: { ...stated, statement: "The data *does not* tell them apart.", wouldDecide: "Trying them." }, report: "The report, in English only." });
    expect(notes).toEqual(["The data does not separate these options: Lonax Memory, Optima Classic. The data does not tell them apart. What would decide: Trying them."]);
  });
});

describe("what it leaves alone", () => {
  it("passes a text draft as it stands: it has no ids", () => {
    expect(check({ findings: [], origin: "plain_text", report: "See https://elsewhere.example/page.", unreachable: [] })).toEqual({ notes: [], troubles: [] });
  });

  it("passes a run with no frame and no records, which goes on as it always did", () => {
    const stored = { findings: [{ claim: "It holds.", quote: "It holds.", sourceClass: "independent_tests" as const, standing: "confirmed" as const, url: "https://lab.example/x" }],
      origin: "reserved_call" as const, report: "It holds.", unreachable: [] };
    expect(check(stored, [], null)).toEqual({ notes: [], troubles: [] });
  });

  it("still checks ids where only the matrix could not be read", () => {
    expect(messages({ ...DRAFT, recordIds: [id(99)] }, RECORDS, null)).toContain(id(99));
    expect(messages({ ...DRAFT, pickRowKey: "x9" }, RECORDS, null)).toBe("");
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

  it("sends a draft back under its own name, with what the answer says if nothing comes of it", async () => {
    const outcome = await run({ ...DRAFT, pickRowKey: "x9" });
    expect(outcome).toMatchObject({ gate: REPORT_CHECK_GATE, kind: "sent_back", message: expect.stringContaining("Outside the matrix") });
    expect(outcome.notes?.join("\n")).toContain("не входит в варианты");
  });

  it("stops sending back at the cap, and the answer carries what stayed wrong", async () => {
    const earlier = Array.from({ length: RESEARCH_ROUND_LIMITS.sendBacksPerCheck }, () => ({ draft: DRAFT, gate: REPORT_CHECK_GATE, message: "Again." }));
    const outcome = await run({ ...DRAFT, pickRowKey: "x9" }, earlier);
    expect(outcome.kind).toBe("accepted");
    expect(outcome.notes?.join("\n")).toContain("не входит в варианты");
  });

  it("costs its check and leaves a note when the store cannot be read, never the answer", async () => {
    const outcome = await run(DRAFT, [], async () => { throw new Error("database down"); });
    expect(outcome.kind).toBe("accepted");
    expect(outcome.notes?.join("\n")).toContain("не удалось завершить");
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
