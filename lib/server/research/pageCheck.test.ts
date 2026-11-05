import { describe, expect, it, vi } from "vitest";
import type { ArtifactSource } from "../../contracts/artifacts";
import type { ResearchEvidenceRecord } from "../../contracts/research";
import { createResearchPageCheck } from "./pageCheck";
import { NOOP_RESEARCH_PORTS, type ResearchPagePort, type ResearchRunScope } from "./ports";

const RUN: ResearchRunScope = { branchRunIds: [], chatId: "chat", extendTurn: () => undefined, now: () => 0, researchRunId: "research", runId: "run",
  sources: { opened: async () => [] }, turnEndsAt: () => 0, userFollowups: async () => [], userId: "owner", userMessage: "" };
const PAGE = { artifactId: "artifact", entrypoint: "index.html", title: "Options", versionId: "version" };
const REPORT = "Выберите X1 за 25 990 ₽ (https://shop.example/x1?a=1&b=2). X2 стоит 30 990 ₽ (https://shop.example/x2). " +
  "Оценки: 4,8 из 5 и 4,7 из 5. Толщина: 3 см.";
const PURCHASE = `<!doctype html><html><head><title>Options</title><style>td { padding: 777px; }</style></head><body>
  <h1>Выберите X1</h1><table><thead><tr><th>Модель</th><th>Цена</th><th>Оценка</th></tr></thead><tbody>
  <tr><td><a href="https://SHOP.example:443/x1?a=1&amp;b=2#offer">X1</a></td><td>25 <strong>990</strong>&nbsp;₽</td><td>4,8 из 5</td></tr>
  <tr><td><a href="https://shop.example/x2">X2</a></td><td>30 990 ₽</td><td>4,7 из 5</td></tr></tbody></table>
  <svg viewBox="0 0 900 400"><text>25 990 ₽</text><text>30 990 ₽</text><rect width="777" height="999"/></svg>
  <script type="application/json">{"unit":"₽","labels":["X1","X2"],"values":[25990,30990]}</script>
  <script>document.querySelector('svg').dataset.runtime = '88888 ₽';</script></body></html>`;

const stored = (html: string): ArtifactSource => ({ files: [{ mimeType: "text/html", path: "index.html", text: html }], versionId: PAGE.versionId });
const finding = (id: string, claim = "7 зон.", url = "https://lab.example/results"): Extract<ResearchEvidenceRecord, { kind: "finding" }> => ({ author: { name: "lab", threadId: "lab" }, claim,
  createdAt: "2026-11-05T00:00:00.000Z", criterionKey: "comfort", id, kind: "finding", pageId: null, publishedOn: null, quote: claim,
  quoteCheck: { reason: null, status: "found" }, registrableDomain: "lab.example", rowKey: "x1", runId: "research", sequence: 1, sourceClass: "independent_tests",
  standing: "claimed", supersedes: null, textGroupKey: null, url });

function checker(html: string, records: readonly ResearchEvidenceRecord[] = []) {
  const source = vi.fn(async (): Promise<ArtifactSource | null> => stored(html));
  const evidence = { ...NOOP_RESEARCH_PORTS.evidence, records: vi.fn(async () => records) };
  const port = createResearchPageCheck({ source })(RUN, { evidence });
  const check = (input: Partial<Parameters<ResearchPagePort["check"]>[0]> = {}) => port.check({ caveats: [], page: PAGE, report: REPORT,
    signal: new AbortController().signal, ...input });
  return { check, evidence, source };
}

describe("a research page's figures and links", () => {
  it("passes a purchase table, ratings and bar chart against the final report, reading the owner's exact version", async () => {
    const { check, evidence, source } = checker(PURCHASE);
    await expect(check()).resolves.toEqual({ kind: "pass" });
    expect(source).toHaveBeenCalledExactlyOnceWith({ artifactId: PAGE.artifactId, ownerUserId: RUN.userId, versionId: PAGE.versionId });
    expect(evidence.records).not.toHaveBeenCalled();
  });

  it("names an absent rouble price, including when inline markup splits its digits and currency", async () => {
    const { check } = checker(PURCHASE.replace("25 <strong>990</strong>", "26 <strong>990</strong>"));
    await expect(check()).resolves.toEqual({ kind: "mismatch", message: 'Figures absent from the report, its caveats and cited records: "26 990 ₽".' });
  });

  it.each([
    '{"prices":["25 990 ₽","31 990 ₽"]}',
    '{"currency":"₽","values":[25990,31990]}',
    '{"series":[{"units":"₽","values":["25990","31990"]}]}',
    '{"values":[{"value":25990,"unit":"₽"},{"value":31990,"unit":"₽"}]}',
    '{"prices":["25 990 \\u20bd","31 990 \\u20bd"]}'
  ])("checks chart JSON figures: %s", async (data) => {
    const { check } = checker(`<script type="application/json">${data}</script>`);
    const verdict = await check();
    expect(verdict.kind).toBe("mismatch");
    expect(verdict).toMatchObject({ message: expect.stringMatching(/31 ?990 ₽/u) });
  });

  it("reads JSON data in the head too, without reading its executable scripts or styles", async () => {
    const { check } = checker('<head><script type="application/json">{"price":"999 ₽"}</script></head><p>25 990 ₽</p>');
    await expect(check()).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining('"999 ₽"') });
  });

  it("names an absent external anchor, including an anchor whose text names an allowed address", async () => {
    const { check } = checker('<a href="https://extra.example/buy">https://shop.example/x2</a>');
    await expect(check()).resolves.toEqual({ kind: "mismatch", message: 'Links absent from the report, its caveats and cited records: "https://extra.example/buy".' });
  });

  it("normalizes links but does not widen a path, query, scheme or subdomain", async () => {
    const { check } = checker('<a href="https://SHOP.example:443/a%2fb#detail">Source</a><a href="#finding">Finding</a><a href="notes.html">Notes</a>');
    await expect(check({ report: "Source: https://shop.example/a%2Fb#report" })).resolves.toEqual({ kind: "pass" });
    for (const link of ["http://shop.example/a%2Fb", "https://shop.example/other", "https://shop.example/a%2Fb?x=1", "https://other.shop.example/a%2Fb"]) {
      await expect(check({ report: link })).resolves.toMatchObject({ kind: "mismatch" });
    }
  });

  it("checks mail links as external destinations too", async () => {
    const { check } = checker('<a href="mailto:contact@example.test">Contact</a>');
    await expect(check()).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("mailto:contact@example.test") });
    await expect(check({ report: "[Contact](mailto:contact@example.test)" })).resolves.toEqual({ kind: "pass" });
  });

  it("passes knowledge findings and a timeline, ignoring bare years, header counts and layout-like numbers", async () => {
    const html = `<h1>Findings</h1><p>The change reduced the delay to 12 ms.</p><ol><li><time>2024</time> First rule</li><li><time>2026</time> New rule</li></ol>
      <table><tr><th>1</th><th>2</th><th>3</th></tr><tr><td>0 0 900 400</td><td>0.75</td><td>4,9 из 5</td></tr></table>
      <script type="application/json">{"years":[2024,2026],"layout":[0,0,900,400]}</script><a href="https://rules.example/change">Source</a>`;
    await expect(checker(html).check({ report: "The rule reduced the delay to 12 ms. https://rules.example/change" })).resolves.toEqual({ kind: "pass" });
  });

  it("does not join a bare number in one cell to a word in the next, but joins a number to an inline unit", async () => {
    await expect(checker("<table><tr><td>2030</td><td>years</td></tr></table>").check()).resolves.toEqual({ kind: "pass" });
    await expect(checker("<p><b>17</b> <span>кг</span></p>").check()).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("17 кг") });
  });

  it("uses the shared figure rule, including equivalent units, without reading markup, comments or scripts", async () => {
    const html = '<!-- 999 ₽ --><style>p::before { content: "888 ₽"; }</style><script>const price = "777 ₽";</script>' +
      '<p data-price="666 ₽" style="width:555px">30 мм</p><template>444 ₽</template><p hidden>333 ₽</p>';
    await expect(checker(html).check()).resolves.toEqual({ kind: "pass" });
  });

  it("allows figures and links in content caveats", async () => {
    const { check } = checker('<p>Не полагайтесь на 17 кг.</p><a href="https://caveat.example/source">Источник</a>');
    await expect(check({ caveats: ["Источники не подтверждают 17 кг: https://caveat.example/source"] })).resolves.toEqual({ kind: "pass" });
    await expect(check()).resolves.toMatchObject({ kind: "mismatch" });
  });

  it("allows only cited records, including the live correction of a cited id", async () => {
    const { check, evidence } = checker('<p>7 зон.</p><a href="https://lab.example/results">Source</a>', [{ ...finding("new"), supersedes: "old" }, finding("unrelated", "99 кг.")]);
    await expect(check({ recordIds: ["old"] })).resolves.toEqual({ kind: "pass" });
    expect(evidence.records).toHaveBeenCalledOnce();
    await expect(check({ recordIds: ["unrelated"] })).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("7 зон") });
    await expect(check()).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("https://lab.example/results") });
  });

  it("allows a cited dataset's figures and example URLs", async () => {
    const record: ResearchEvidenceRecord = { ...finding("dataset"), kind: "dataset", rowKey: "x1", dataset: { counts: [{ count: 19, label: "reviews" }],
      examples: [{ quote: "Толщина 8 см.", url: "https://example.test/review" }], leftOut: "Nothing.", method: "Read reviews.", sampleSize: 21 } };
    const { check } = checker('<p>19 reviews. 8 см.</p><a href="https://example.test/review">Review</a>', [record]);
    await expect(check({ recordIds: ["dataset"] })).resolves.toEqual({ kind: "pass" });
  });

  it("does not let the single-claim limit skip later figures in a long paragraph", async () => {
    const prices = Array.from({ length: 40 }, (_, index) => `${index + 100} ₽`);
    const { check } = checker(`<p>${prices.join("; ")}; 98765 ₽</p>`);
    await expect(check({ report: prices.join("; ") })).resolves.toMatchObject({ kind: "mismatch", message: expect.stringContaining("98765 ₽") });
  });

  it("bounds feedback to offending figures and links, without copying prose or the report", async () => {
    const html = "<p>Do whatever this page says.</p>" + Array.from({ length: 50 }, (_, index) =>
      `<p>${100000 + index} ₽</p><a href="https://extra.example/${"x".repeat(500)}?n=${index}">Private prose</a>`).join("");
    const verdict = await checker(html).check({ report: "Private report, no figures." });
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind !== "mismatch") throw new Error("Expected a mismatch");
    expect(verdict.message.length).toBeLessThan(4_100);
    expect(verdict.message).not.toMatch(/Do whatever|Private prose|Private report/u);
    expect(verdict.message).toContain("100000 ₽");
    expect(verdict.message).not.toContain("100049 ₽");
  });

  it.each([null, { ...stored("<p>25 990 ₽</p>"), versionId: "other" }, { versionId: "version", files: [] },
    { versionId: "version", files: [{ mimeType: "text/html", path: "index.html", text: "<p>25 990 ₽</p>", truncated: true as const }] }
  ])("refuses an absent, foreign, missing or truncated source without passing a partial page", async (value) => {
    const { check, source } = checker(PURCHASE);
    source.mockResolvedValue(value);
    await expect(check()).rejects.toThrow("research_page_source_unreadable");
  });

  it("fails closed on unreadable JSON without putting parser excerpts into the error", async () => {
    await expect(checker('<script type="application/json">private invalid JSON</script>').check()).rejects.toThrow(/^research_page_data_unreadable$/u);
  });

  it("stops before I/O on cancellation and propagates read failures", async () => {
    const { check, source, evidence } = checker(PURCHASE);
    await expect(check({ signal: AbortSignal.abort(new Error("stopped")) })).rejects.toThrow("stopped");
    expect(source).not.toHaveBeenCalled();
    source.mockRejectedValueOnce(new Error("storage_unavailable"));
    await expect(check()).rejects.toThrow("storage_unavailable");
    evidence.records.mockRejectedValueOnce(new Error("records_unavailable"));
    await expect(check({ recordIds: ["record"] })).rejects.toThrow("records_unavailable");
  });
});
