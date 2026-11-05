import { describe, expect, it } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME } from "../../contracts/research";
import type { TranscriptItem } from "../engine/transcript";
import { TOOL_RESULT_LIMITS, toolOutputExcerpt } from "../engine/toolResults";
import type { ResearchOpenedSource } from "./gates";
import { checkQuotes, claimFigures, claimPrices, figuresNotIn, normalizeQuotedText, QUOTE_EXCERPT_LIMITS, quoteIsIn } from "./quoteCheck";
import { createResearchSources, researchEvidenceKind, RESEARCH_SOURCE_LIMITS } from "./sources";

const LINK = "https://lab.example/x1";
const page = (text: string, url: string | null = LINK, extra: Partial<ResearchOpenedSource> = {}): ResearchOpenedSource =>
  ({ partial: false, text, toolName: "fetch_url", url, ...extra });
const finding = (quote: string, url = LINK) => ({ quote, url });
/** The verdict alone; what `found` carries is tested below. */
const one = (quote: string, opened: readonly ResearchOpenedSource[] | null, url?: string) => {
  const check = checkQuotes([finding(quote, url)], opened)[0]!;
  return check.status === "found" ? { status: check.status } : check;
};

const OTHER_PAGE = "https://other.example/a";
const NEVER_OPENED = "https://never.example/x";
const SHELL = "mcp__workspace__sandbox_shell";

describe("the quote check", () => {
  it("finds a quote in a page an agent read, whichever page the run read it on", () => {
    expect(one("held up after 10 years", [page("The X1 held up after 10 years of use.")])).toEqual({ status: "found" });
    // A redirect or another address is the verifier's to judge: the quote is real.
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", OTHER_PAGE)])).toEqual({ status: "found" });
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", null, { browser: true, toolName: SHELL })])).toEqual({ status: "found" });
    expect(one("held up after 10 years", [page("[browser #1] open @ lab.example/x1\nThe X1 held up after 10 years.", null, { toolName: SHELL })])).toEqual({ status: "found" });
  });

  it("catches an invented quote on a page nobody opened", () => {
    expect(one("never wears out", [page("The X1 held up after 10 years.", OTHER_PAGE)], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("never wears out", [], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("...", [page("...", OTHER_PAGE)], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("calls a quote missing from a page that really was fetched not verbatim, which is no invention", () => {
    expect(one("held up after a decade", [page("The X1 held up after 10 years.")])).toEqual({ status: "not_verbatim" });
    // The fragment in a link does not name another page, and the address need not match in form.
    expect(one("held up after a decade", [page("The X1 held up after 10 years.", "HTTPS://LAB.EXAMPLE:443/x1")], `${LINK}#results`)).toEqual({ status: "not_verbatim" });
  });

  it("does not take a search snippet for an opened page", () => {
    const search = page("held up after 10 years", null, { toolName: "search_selected_engines" });
    expect(one("held up after 10 years", [search], NEVER_OPENED)).toEqual({ reason: "search_snippet_only", status: "unsupported" });
    expect(one("held up after 10 years", [search, page("The X1 held up after 10 years.")])).toEqual({ status: "found" });
  });

  it.each([SHELL, "mcp__notes__read"])("does not take %s output for a page: a quote there is not checked, never found", (toolName) => {
    expect(one("held up after 10 years", [page("echo held up after 10 years", null, { toolName })], NEVER_OPENED)).toEqual({ reason: "other_tool_output", status: "not_checked" });
    // Not there either: nothing explains it.
    expect(one("never wears out", [page("echo held up", null, { toolName })], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("ignores what an agent wrote itself", () => {
    expect(one("held up after 10 years", [page("a report quoting: held up after 10 years", null, { toolName: "call_subagent" })], NEVER_OPENED))
      .toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("reads saved results stringified once or twice", () => {
    const saved = JSON.stringify({ text: "She said: \"it held up\"\nafter 10\tyears — and more", url: LINK });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(saved)])).toEqual({ status: "found" });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(JSON.stringify({ output: saved }))])).toEqual({ status: "found" });
    expect(one("caf\u00e9 au lait", [page("caf\\u00e9 au lait")])).toEqual({ status: "found" });
  });

  it("tolerates what copying changes and still misses different words", () => {
    const text = "«Матрас» выдержал 10\u00a0лет — без про\u00adсадки, **как обещано**, см. [отчёт](https://lab.example/r). Ре\uFB01нанс.";
    for (const quote of ["\"Матрас\" выдержал 10 лет - без просадки", "Матрас\" выдержал", "как обещано, см. отчёт.", "выдержал 10 лет … как обещано", "“Матрас” выдержал [...] без просадки", "Реfiнанс"]) {
      expect(one(quote, [page(text, OTHER_PAGE)], NEVER_OPENED), quote).toEqual({ status: "found" });
    }
    expect(one("выдержал 20 лет", [page(text, OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
    // Out of order is no quote of this page.
    expect(one("как обещано ... выдержал", [page(text, OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
  });

  it("keeps case and symbols, since they carry meaning", () => {
    const opened = [page("Its laser draws 1 mW at 5' and covers 10 m².")];
    expect(one("1 mW", opened)).toEqual({ status: "found" });
    for (const quote of ["1 MW", "at 5\"", "10 m2", "ITS LASER"]) expect(one(quote, opened), quote).toEqual({ status: "not_verbatim" });
    expect(one("1 MW", [page("Its laser draws 1 mW.", OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
  });

  it("says not checked, never unsupported, for a page read through the browser and not stored", () => {
    const steps = page("Running.\n[browser #3 · lab] open @ www.lab.example/x1\n[browser #4 · lab] click: button \"Next\" @ lab.example/x2\nSaved to a file.", null, { toolName: SHELL });
    expect(one("held up after 10 years", [steps])).toEqual({ reason: "browser_page", status: "not_checked" });
    expect(one("held up after 10 years", [page(JSON.stringify({ stdout: "[browser #3] open @ lab.example/x1\n" }), null, { toolName: SHELL })])).toEqual({ reason: "browser_page", status: "not_checked" });
    // A browser on another site says nothing of this link.
    expect(one("held up after 10 years", [steps], "https://shop.example/x1")).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    // Page text that looks like a step is indented by the helper, so it is no step.
    expect(one("held up after 10 years", [page("  [browser #3] open @ lab.example/x1", OTHER_PAGE)])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("says not checked when the source that could hold the quote is only an excerpt", () => {
    expect(one("held up after 10 years", [page("excerpt", LINK, { partial: true })])).toEqual({ reason: "partial_source", status: "not_checked" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: SHELL })])).toEqual({ reason: "partial_source", status: "not_checked" });
    // An excerpt of another page or of a search says nothing of this one.
    expect(one("held up after 10 years", [page("excerpt", OTHER_PAGE, { partial: true })])).toMatchObject({ status: "unsupported" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: "search_engine_1" })])).toMatchObject({ status: "unsupported" });
    // What an excerpt does hold is still found.
    expect(one("excerpt", [page("the excerpt", LINK, { partial: true })])).toEqual({ status: "found" });
  });

  it("says not checked when the run's text could not be read or is over what one check reads", () => {
    expect(one("held up", null)).toEqual({ reason: "sources_unreadable", status: "not_checked" });
    const many = Array.from({ length: RESEARCH_SOURCE_LIMITS.results }, () => page("x", OTHER_PAGE));
    expect(one("held up", many, NEVER_OPENED)).toEqual({ reason: "sources_over_limit", status: "not_checked" });
  });

  it("returns the passage around a quote it found, bounded on each side, one continuous text", () => {
    const text = `${"a".repeat(1_000)} the quoted words ${"b".repeat(1_000)}`;
    const check = checkQuotes([finding("the quoted words")], [page(text)])[0]!;
    if (check.status !== "found") throw new Error("expected found");
    expect(check.excerpt.quoted).toBe("the quoted words");
    expect(check.excerpt.before.length).toBe(QUOTE_EXCERPT_LIMITS.sideCharacters);
    expect(check.excerpt.after.length).toBe(QUOTE_EXCERPT_LIMITS.sideCharacters);
    expect(text).toContain(`${check.excerpt.before}${check.excerpt.quoted}${check.excerpt.after}`);
  });

  it("keeps a long quote's excerpt bounded and continuous, and spans an ellipsis's parts", () => {
    const long = "x".repeat(QUOTE_EXCERPT_LIMITS.quotedCharacters + 100);
    const check = checkQuotes([finding(long)], [page(`before ${long} after`)])[0]!;
    if (check.status !== "found") throw new Error("expected found");
    expect(check.excerpt.quoted.length).toBe(QUOTE_EXCERPT_LIMITS.quotedCharacters);
    expect(check.excerpt.after).toBe(`${"x".repeat(100)} after`);
    const parts = checkQuotes([finding("first ... third")], [page("first second third fourth")])[0]!;
    expect(parts).toMatchObject({ excerpt: { after: " fourth", before: "", quoted: "first second third" } });
  });

  it("takes the excerpt from the cited page when several hold the quote", () => {
    const opened = [page("elsewhere: the words", OTHER_PAGE), page("cited: the words")];
    expect(checkQuotes([finding("the words")], opened)[0]).toMatchObject({ excerpt: { before: "cited: " } });
    expect(checkQuotes([finding("the words", NEVER_OPENED)], opened)[0]).toMatchObject({ excerpt: { before: "elsewhere: " } });
  });

  it("says whose words a passage is, and prefers the cited page and then one that may be it", () => {
    const fromOther = checkQuotes([finding("the words")], [page("shop B: the words", OTHER_PAGE)])[0];
    expect(fromOther).toMatchObject({ excerpt: { source: { kind: "other", url: OTHER_PAGE } }, status: "found" });
    expect(checkQuotes([finding("the words")], [page("the words")])[0]).toMatchObject({ excerpt: { source: { kind: "cited" } } });
    const browser = page("the words", null, { browser: true, toolName: SHELL });
    expect(checkQuotes([finding("the words")], [browser])[0]).toMatchObject({ excerpt: { source: { kind: "unknown" } } });
    expect(checkQuotes([finding("the words")], [page("shop B: the words", OTHER_PAGE), browser])[0]).toMatchObject({ excerpt: { before: "", source: { kind: "unknown" } } });
  });

  it("knows a browser page on another host for another page, and one on the cited host only as unknown", () => {
    const other = page("[browser #1] open @ shop-b.example/x\nthe words", null, { toolName: SHELL });
    expect(checkQuotes([finding("the words")], [other])[0]).toMatchObject({ excerpt: { source: { kind: "other", url: "shop-b.example" } } });
    const same = page("[browser #1] open @ www.lab.example/x\nthe words", null, { toolName: SHELL });
    expect(checkQuotes([finding("the words")], [same])[0]).toMatchObject({ excerpt: { source: { kind: "unknown" } } });
  });

  it("says which source holds the quote, so a write keeps that one", () => {
    const opened = [page("nothing here", OTHER_PAGE), page("search result: the words", null, { toolName: "search_engine_1" }), page("the words")];
    expect(checkQuotes([finding("the words")], opened)[0]).toMatchObject({ opened: 2, status: "found" });
  });

  it("reads a miss as not knowing when the caller stopped at a bound, and never a find", () => {
    const check = (moreUnread: boolean) => checkQuotes([finding("held up", NEVER_OPENED)], [page("nothing here", OTHER_PAGE)], { moreUnread })[0];
    expect(check(false)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(check(true)).toEqual({ reason: "sources_over_limit", status: "not_checked" });
    expect(checkQuotes([finding("nothing")], [page("nothing here")], { moreUnread: true })[0]).toMatchObject({ status: "found" });
  });

  it("answers for a text the way the check reads it", () => {
    expect(quoteIsIn("«held up» ... 10 years", "It held up after 10 years.")).toBe(true);
    expect(quoteIsIn("held up", "It held firm.")).toBe(false);
  });

  it.each([RECORD_EVIDENCE_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME, CHANGE_RESEARCH_FRAME_TOOL_NAME])("takes what %s returns for an agent's own words", (toolName) => {
    expect(researchEvidenceKind({ text: "held up after 10 years", toolName })).toBe("agent_written");
    expect(one("held up after 10 years", [page("held up after 10 years", null, { toolName })])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("normalizes both sides alike", () => {
    expect(normalizeQuotedText(" A\u00a0\u2014\u00a0B\\n«C» ")).toBe("A - B \"C\"");
    expect(normalizeQuotedText("\\\\\"x\\\\\"")).toBe("\"x\"");
    expect(normalizeQuotedText("‘a’ m²")).toBe("'a' m²");
  });
});

describe("what the sources read of a run", () => {
  const threads = (items: TranscriptItem[]) => ({ backgroundRunIds: async () => [], threadEffectItems: async () => [{ items, threadId: "t" }] });
  const read = async (items: TranscriptItem[], savedResults: Parameters<typeof createResearchSources>[0]["savedResults"] = { read: async () => null }) =>
    createResearchSources({ chatId: "c", items: () => [], run: { branchRunIds: [], researchRunId: "r", runId: "r" }, savedResults, threads: threads(items), userId: "u" }).opened(new AbortController().signal);

  it("marks a long result whose saved copy failed as partial, so a real quote on it is not called invented", async () => {
    const whole = `start ${"x".repeat(TOOL_RESULT_LIMITS.inlineChars)} held up after 10 years ${"y".repeat(TOOL_RESULT_LIMITS.inlineChars)} end`;
    const excerpt = toolOutputExcerpt(whole, { unsavedReason: "saved_results_budget_reached" });
    expect(excerpt.handle).toBeNull();
    const opened = await read([
      { arguments: JSON.stringify({ url: LINK }), callId: "a", id: "a1", kind: "tool_call", name: "fetch_url" },
      { callId: "a", id: "a2", kind: "tool_result", name: "fetch_url", outcome: "complete", output: excerpt.output },
      { arguments: JSON.stringify({ url: OTHER_PAGE }), callId: "b", id: "b1", kind: "tool_call", name: "fetch_url" },
      { callId: "b", id: "b2", kind: "tool_result", name: "fetch_url", outcome: "complete", output: "short and whole" }
    ]);
    expect(opened.map((source) => source.partial)).toEqual([true, false]);
    expect(one("held up after 10 years", opened)).toEqual({ reason: "partial_source", status: "not_checked" });
  });

  it("marks what a browser command printed, step line or not, and nothing else", async () => {
    const opened = await read([
      { arguments: JSON.stringify({ command: "aiqsa-browser text" }), callId: "a", id: "a1", kind: "tool_call", name: SHELL },
      { callId: "a", id: "a2", kind: "tool_result", name: SHELL, outcome: "complete", output: "held up after 10 years" },
      { arguments: JSON.stringify({ command: "echo held up" }), callId: "b", id: "b1", kind: "tool_call", name: SHELL },
      { callId: "b", id: "b2", kind: "tool_result", name: SHELL, outcome: "complete", output: "held up" }
    ]);
    expect(opened.map((source) => researchEvidenceKind(source))).toEqual(["page", "other"]);
  });
});

describe("a claim's prices", () => {
  const prices = (claim: string) => claimPrices(claim).map(({ currency, text, value }) => ({ currency, text, value }));

  it("reads one number in one currency, the sign before it or the currency after it, a count between taken in", () => {
    expect(prices("Lonax Memory 160×200 в shop.example: 59 732 ₽, продавец ИП Иванов, 2026-11-01.")).toEqual([{ currency: "RUB", text: "59 732 ₽", value: 59_732 }]);
    expect(prices("Optima 160×200 — 25 000 руб.")).toEqual([{ currency: "RUB", text: "25 000 руб", value: 25_000 }]);
    expect(prices("Цена 30 000 р. за штуку")).toEqual([{ currency: "RUB", text: "30 000 р", value: 30_000 }]);
    expect(prices("От 25 тыс. руб.")).toEqual([{ currency: "RUB", text: "25 тыс. руб", value: 25_000 }]);
    expect(prices("Now $1,299 at the shop")).toEqual([{ currency: "$", text: "$1,299", value: 1_299 }]);
    expect(prices("Around $25k")).toEqual([{ currency: "$", text: "$25k", value: 25_000 }]);
    expect(prices("Precio 1.500 € con envío")).toEqual([{ currency: "EUR", text: "1.500 €", value: 1_500 }]);
    expect(prices("Precio 1.299,90 EUR")).toEqual([{ currency: "EUR", text: "1.299,90 EUR", value: 1_299.9 }]);
    expect(prices("Costs 120 USD")).toEqual([{ currency: "USD", text: "120 USD", value: 120 }]);
  });

  it("reads no price from a size, a share, a rating, a range or a range's upper end, and two from a price beside an old one", () => {
    expect(prices("Матрас 160×200 см, скидка 10%, 4,8 из 5")).toEqual([]);
    expect(prices("25 000–28 000 ₽")).toEqual([]);
    expect(prices("25 000 — 28 000 ₽")).toEqual([]);
    expect(prices("от 25 000 до 32 000 ₽")).toEqual([]);
    expect(prices("up to $300")).toEqual([]);
    expect(prices("от 25 000 ₽ до 32 000 ₽")).toEqual([{ currency: "RUB", text: "25 000 ₽", value: 25_000 }]);
    expect(prices("25 000 ₽, было 32 000 ₽")).toHaveLength(2);
  });
});

describe("a claim's figures", () => {
  const figures = (claim: string) => claimFigures(claim).map(({ text }) => text);
  /** The figures of the claim this text does not write. */
  const missing = (claim: string, text: string) => figuresNotIn(claimFigures(claim), text).map(({ text: shown }) => shown);

  it("are its numbers with their units, in the research languages", () => {
    expect(figures("Слои: латекс 3 см, кокос 1 см.")).toEqual(["3 см", "1 см"]);
    expect(figures("Нагрузка до 140 кг на место, 7 зон жёсткости, 7-зонный блок, цена 59 732 ₽.")).toEqual(["140 кг", "7 зон", "7-зонный", "59 732 ₽"]);
    expect(figures("Holds 140 kg, has 3 layers and a 10-year warranty, costs $599 or € 1.200, draws 300 W.")).toEqual(["140 kg", "3 layers", "10-year", "$599", "€ 1.200", "300 W"]);
    expect(figures("Soporta 140 kilos, tiene 3 capas y 10 años de garantía; cuesta 599 €.")).toEqual(["140 kilos", "3 capas", "10 años", "599 €"]);
    expect(figures("Размер 160×200 см, высота 1,5 м, скидка 15%, 1,2 млн руб.")).toEqual(["160×200 см", "1,5 м", "15%", "1,2 млн"]);
  });

  it("leave out what is no figure: a name's number, a rating's scale, a date", () => {
    expect(figures("Lumo Flex 20 стоит 59 732 ₽.")).toEqual(["59 732 ₽"]);
    expect(figures("The iPhone 15 Pro and the Galaxy S24 rate 4.8 of 5 and 4,6 из 5.")).toEqual([]);
    expect(figures("COVID-19 spread on 12.05.2024 and 24/7 lines opened at 10:30 sharp.")).toEqual([]);
    expect(figures("The X1 holds up.")).toEqual([]);
  });

  it("are found however a page writes the number: grouped by any space, with a decimal comma, in another unit or in words", () => {
    expect(missing("Цена 59 732 ₽.", "Цена: 59732 руб.")).toEqual([]);
    expect(missing("Цена 59732 руб.", "Цена: 59 732 ₽")).toEqual([]);
    for (const page of ["59 732 ₽", "59 732 ₽", "59 732,00 ₽", "59,732 RUB", "59.732 руб.", "59'732"]) expect(missing("Цена 59 732 ₽.", page)).toEqual([]);
    expect(missing("Толщина 1,5 см.", "thickness 1.5 cm")).toEqual([]);
    expect(missing("Weighs 2.5 kg.", "Вес 2,5 кг")).toEqual([]);
    for (const page of ["160x200", "160 x 200", "160 х 200", "160X200 см", "ширина 160 см, длина 200 см"]) expect(missing("Размер 160×200 см.", page)).toEqual([]);
    expect(missing("Высота 1,5 м.", "Высота: 150 см")).toEqual([]);
    expect(missing("Оборот 1,2 млн руб.", "Оборот: 1 200 000 руб.")).toEqual([]);
    expect(missing("Оборот 1 200 000 руб.", "Оборот 1,2 млн руб.")).toEqual([]);
    expect(missing("Матрас имеет 7 зон.", "семь зон жёсткости")).toEqual([]);
    expect(missing("Матрас имеет 7 зон.", "семизонный пружинный блок")).toEqual([]);
    expect(missing("Tiene 3 capas.", "tres capas")).toEqual([]);
    expect(missing("Has 3 layers.", "three layers")).toEqual([]);
    // A table puts the unit in its header.
    expect(missing("Латекс 3 см.", "| Слой | Толщина, см |\n| латекс | 3 |")).toEqual([]);
    expect(missing("Латекс 3 см.", "латекс 3см")).toEqual([]);
  });

  it("are missing when the text writes another number or none", () => {
    expect(missing("Слои: латекс 3 см, кокос 1 см.", "латекс, кокос")).toEqual(["3 см", "1 см"]);
    expect(missing("Слои: латекс 3 см, кокос 1 см.", "латекс 3 см, кокос")).toEqual(["1 см"]);
    expect(missing("Нагрузка 140 кг.", "Нагрузка до 120 кг")).toEqual(["140 кг"]);
    expect(missing("Цена 59 732 ₽.", "Цена 59 733 ₽")).toEqual(["59 732 ₽"]);
    expect(missing("Высота 1,5 м.", "Высота 15 см")).toEqual(["1,5 м"]);
    expect(missing("Размер 160×200 см.", "160×190 см")).toEqual(["160×200 см"]);
    expect(missing("Скидка 15%.", "скидка 5%")).toEqual(["15%"]);
    expect(missing("Matrás de 3 capas y 25 cm.", "colchón de 3 capas")).toEqual(["25 cm"]);
  });

  it("read a JSON-escaped page as the quote check does", () => {
    expect(missing("Латекс 3 см.", JSON.stringify(JSON.stringify("латекс 3 см")))).toEqual([]);
  });
});
