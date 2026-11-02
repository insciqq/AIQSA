import type { Prisma, ResearchEvidence } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_PAGE_LIMITS, type ResearchEvidenceRecord, type ResearchRecordInput, type ResearchStanding } from "../../contracts/research";
import { createResearchEvidenceRepository, type ResearchEvidenceAppend } from "./evidenceRepository";
import { createResearchEvidenceStore } from "./evidenceStore";
import { researcherMethodFooter } from "./method";
import type { ResearchEvidenceWritten, ResearchRunScope } from "./ports";
import * as quality from "./sourceQuality";

const RELEASE = `The Northfield laboratory announced the results of its new mattress durability study.
Researchers tested twenty samples using a mechanical roller that applied a constant load for eighty thousand cycles.
Each mattress rested for a full day before technicians measured its height at five marked locations.
The laboratory recorded changes in firmness using a calibrated pressure sensor and repeated every measurement three times.
The results showed that reinforced edges retained their shape while several softer foam samples developed permanent depressions.
Temperature and humidity remained constant throughout the experiment to make the measurements comparable across all samples.
The full protocol includes the equipment calibration records, individual measurements and photographs of each tested mattress.
Funding came from the university research budget and participating manufacturers did not review the results before publication.
These accelerated measurements describe changes under the stated laboratory conditions and do not establish a household service life.`;
const ARTICLE = `Choosing a mattress requires attention to sleeping position and personal comfort rather than laboratory cycle counts.
Side sleepers often benefit from softer layers near the shoulder, while people who sleep on their back may prefer firmer support.
Retail trials should last long enough to notice pressure points and should include the pillow that will be used at home.
Ask about return transport, hygiene requirements and any fee charged for collecting a mattress that feels uncomfortable.
A heavier partner may need a different firmness, so couples can consider separate cores beneath one removable cover.
Ventilation depends on the bed base and room conditions as well as the material inside the mattress.
Manufacturer warranties commonly cover visible defects but exclude ordinary comfort preferences and gradual surface changes.
The most useful comparison is a documented home trial with clear return terms rather than a ranking compiled from product descriptions.`;
const QUOTE = "The Northfield laboratory announced the results";
const URL = "https://lab.example.org/study";

type Finding = Extract<ResearchRecordInput, { kind: "finding" }>;
type StoredFinding = Extract<ResearchEvidenceRecord, { kind: "finding" }>;
const input = (url = URL): Finding => ({ claim: "A durability study was published.", criterionKey: "durability", kind: "finding", quote: QUOTE,
  rowKey: "mattress", sourceClass: "independent_tests", standing: "confirmed", supersedes: null, url });

function record(url = URL, text: string | null = RELEASE, extra: Partial<StoredFinding> = {}): StoredFinding {
  return { ...input(url), author: { name: null, threadId: null }, createdAt: "2026-11-02T00:00:00.000Z", id: url, pageId: null, quoteCheck: null,
    runId: "run", sequence: 0, ...quality.prepareResearchSourceQuality(input(url), text === null ? null : { text, url }), ...extra };
}

afterEach(() => vi.restoreAllMocks());

describe("source identity", () => {
  it.each<[string, string | null]>([
    ["https://news.lab.example.co.uk/study", "example.co.uk"],
    ["https://WWW.Example.ORG.:443/other", "example.org"],
    ["https://127.0.0.1:8443/study", "127.0.0.1"],
    ["https://[2001:db8::1]/study", "[2001:db8::1]"],
    ["http://localhost/study", "localhost"],
    ["https://alice.github.io/study", "alice.github.io"],
    ["https://bob.github.io/study", "bob.github.io"],
    ["not a link", null], ["file:///study", null]
  ])("derives the registrable domain or host of %s", (url, expected) => {
    expect(quality.researchRegistrableDomain(url)).toBe(expected);
  });

  it("counts two different pages of one site once, even with distinct text keys", () => {
    const records = [record(), record("https://news.example.org/guide", ARTICLE)];
    expect(records[0]?.textGroupKey).not.toBe(records[1]?.textGroupKey);
    expect(quality.countIndependentSources(records)).toBe(1);
    expect(quality.countIndependentSourcesByClass(records).independent_tests).toBe(1);
  });

  it("groups a copied release with a changed heading on another domain", () => {
    const first = record(URL, `New durability study released\n${RELEASE}`);
    const copy = record("https://news.example.net/release", `Mattress research findings announced\n${RELEASE}`);
    expect(copy.textGroupKey).not.toBe(first.textGroupKey);
    const grouped = { ...copy, textGroupKey: quality.researchTextGroupKey(copy.textGroupKey, [first.textGroupKey]) };
    expect(grouped.textGroupKey).toBe(first.textGroupKey);
    expect(quality.countIndependentSources([first, grouped])).toBe(1);
    expect(first.textGroupKey).toMatch(/^[0-9a-f]{1,64}$/u);
  });

  it("keeps different articles about the same topic independent", () => {
    const first = record();
    const other = record("https://consumer.example.net/mattresses", ARTICLE);
    expect(quality.researchTextGroupKey(other.textGroupKey, [first.textGroupKey])).toBe(other.textGroupKey);
    expect(quality.countIndependentSources([first, other])).toBe(2);
  });

  it("normalizes case, Unicode presentation and spacing, and handles empty or short text conservatively", () => {
    expect(quality.researchTextFingerprint("ＦＯＡＭ\nTest!")).toBe(quality.researchTextFingerprint("foam test"));
    expect(quality.researchTextFingerprint("  …  ")).toBeNull();
    const first = quality.researchTextFingerprint("Mattress foam retained its height");
    const different = quality.researchTextFingerprint("Mattress foam lost its height");
    expect(quality.researchTextGroupKey(different, [first])).toBe(different);
    expect(quality.researchTextGroupKey(null, [first])).toBeNull();
  });

  it("uses the first near match and compares at most the page bound", () => {
    const first = "100000000000000000";
    const second = "100000000000000003";
    const candidate = "100000000000000001";
    expect(quality.researchTextGroupKey(candidate, [first, second])).toBe(first);
    expect(quality.researchTextGroupKey(candidate, [second, first])).toBe(second);
    expect(quality.researchTextGroupKey(candidate, [...Array<string>(RESEARCH_PAGE_LIMITS.pagesPerRun).fill("10ffffffffffffffff"), first])).toBe(candidate);
    expect(quality.researchTextGroupKey(candidate, [null, "bad-key"])).toBe(candidate);
  });

  it("joins domains and copies transitively, independently of record order", () => {
    const first = record(URL, RELEASE);
    const sameSite = record("https://example.org/guide", ARTICLE, { sourceClass: "owner_reviews" });
    const copy = record("https://elsewhere.net/guide", ARTICLE, { sourceClass: "primary_official" });
    const other = record("https://other.net/measurement", "A separate measurement.");
    const records = [first, sameSite, copy, other];
    expect(quality.researchSourceCounts(records)).toEqual({ independent: 2,
      byClass: { action_channel: 0, independent_tests: 2, owner_reviews: 1, primary_official: 1 } });
    expect(quality.researchSourceCounts([...records].reverse())).toEqual(quality.researchSourceCounts(records));
  });

  it("counts a copy shared by independent tests and owner reviews once in the independent total", () => {
    const test = record();
    const review = record("https://owners.example.net/review", RELEASE, { sourceClass: "owner_reviews" });
    expect(quality.researchSourceCounts([test, review])).toEqual({ independent: 1,
      byClass: { action_channel: 0, independent_tests: 1, owner_reviews: 1, primary_official: 0 } });
  });

  it("does not connect independent groups through a maker's document", () => {
    const test = record();
    const review = record("https://owners.example.net/review", ARTICLE, { sourceClass: "owner_reviews" });
    const maker = record("https://owners.example.net/specification", RELEASE, { sourceClass: "primary_official" });
    expect(quality.researchSourceCounts([test, review, maker])).toEqual({ independent: 2,
      byClass: { action_channel: 0, independent_tests: 1, owner_reviews: 1, primary_official: 1 } });
  });

  it("falls back to a domain without page text and never counts missing or unreachable evidence", () => {
    const base = record(URL, null);
    const missing: ResearchEvidenceRecord = { ...base, criterionKey: "durability", kind: "not_found", reason: "No results.", rowKey: "mattress" };
    const unreachable: ResearchEvidenceRecord = { ...base, kind: "unreachable", reason: "Could not open.", target: URL };
    expect(quality.countIndependentSources([base, record("https://example.org/second", null)])).toBe(1);
    expect(quality.countIndependentSources([missing, unreachable, record("invalid", null)])).toBe(0);
    expect(quality.countIndependentSources([record(URL, null, { registrableDomain: null })])).toBe(1);
  });
});

describe("seller evidence", () => {
  it("treats an independent label on the action channel's domain as the seller's claim, including other cells", () => {
    const supposedlyIndependent = record("https://reviews.shop.example.org/test", ARTICLE);
    const shop = record("https://shop.example.org/product", null, { criterionKey: "price", sourceClass: "action_channel" });
    const live = [supposedlyIndependent, shop];
    expect(quality.researchSourceClass(supposedlyIndependent, live)).toBe("action_channel");
    expect(quality.researchSourceStanding(supposedlyIndependent, live)).toBe("claimed");
    expect(quality.countIndependentSources(live)).toBe(0);
    expect(quality.countIndependentSourcesByClass(live)).toEqual({ action_channel: 1, independent_tests: 0, owner_reviews: 0, primary_official: 0 });
    expect(quality.countIndependentSources([supposedlyIndependent], live)).toBe(0);
    expect(quality.countIndependentSourcesByClass([supposedlyIndependent], live).action_channel).toBe(1);
    expect(supposedlyIndependent.sourceClass).toBe("independent_tests");
    expect(supposedlyIndependent.standing).toBe("confirmed");
  });

  it.each(["Price: $249\nAdd to cart", "Price: EUR 249\n- button \"Order now\" [ref=e5]", "Цена: 29 990 ₽\nВ корзину", "Цена: 29990 руб.\nКупить",
    "Precio: 499,00 €\nAñadir al carrito", "499 €\n- button \"Comprar ahora\" [ref=e7]"])(
    "keeps shop signals from page text outside the quote: %s", (text) => {
      const seller = record(URL, `${RELEASE}\n${text}`);
      expect(seller.kind === "finding" && seller.quote).toBe(QUOTE);
      expect(quality.researchShopText(text)).toBe(true);
      expect(quality.researchSourceClass(seller, [seller])).toBe("action_channel");
      expect(quality.researchSourceStanding(seller, [seller])).toBe("claimed");
      expect(quality.countIndependentSources([seller])).toBe(0);
      expect(quality.countIndependentSourcesByClass([seller])).toEqual({ action_channel: 1, independent_tests: 0, owner_reviews: 0, primary_official: 0 });
    }
  );

  it.each<["finding" | "dataset", ResearchStanding]>([
    ["finding", "confirmed"], ["finding", "claimed"], ["finding", "not_verified"],
    ["dataset", "confirmed"], ["dataset", "claimed"], ["dataset", "not_verified"]
  ])("keeps an owner_reviews %s on a shop page independent with its %s standing", (kind, standing) => {
    const shop = record("https://market.example.org/product", "$249\nAdd to cart", { sourceClass: "action_channel" });
    const finding = record("https://market.example.org/product/reviews", "Owners report lasting comfort.\n$249\nAdd to cart", { sourceClass: "owner_reviews", standing });
    const owner: ResearchEvidenceRecord = kind === "finding" ? finding : { ...finding, kind: "dataset", rowKey: "mattress",
      dataset: { counts: [{ count: 2, label: "comfortable" }], examples: [{ quote: "Owners report lasting comfort.", url: finding.url }],
        leftOut: "No long-term reviews.", method: "Read two owners' reviews.", sampleSize: 2 } };
    const live = [shop, owner];
    expect(quality.researchSourceClass(owner, live)).toBe("owner_reviews");
    expect(quality.researchSourceStanding(owner, live)).toBe(standing);
    expect(quality.countIndependentSources([owner])).toBe(1);
    expect(quality.countIndependentSources([owner], live)).toBe(1);
    expect(quality.researchSourceCounts(live)).toEqual({ independent: 1,
      byClass: { action_channel: 1, independent_tests: 0, owner_reviews: 1, primary_official: 0 } });
  });

  it.each([false, true])("keeps a maker's documents primary and outside the independent total (shop page: %s)", (selling) => {
    const maker = record("https://maker.example.org/specification", selling ? `${RELEASE}\n$249\nAdd to cart` : RELEASE, { sourceClass: "primary_official" });
    const shop = record("https://maker.example.org/product", "$249\nAdd to cart", { sourceClass: "action_channel" });
    expect(quality.researchSourceClass(maker, [maker, shop])).toBe("primary_official");
    expect(quality.researchSourceStanding(maker, [maker, shop])).toBe("confirmed");
    expect(quality.researchSourceCounts([maker])).toEqual({ independent: 0,
      byClass: { action_channel: 0, independent_tests: 0, owner_reviews: 0, primary_official: 1 } });
    expect(quality.researchSourceCounts([maker, shop])).toEqual({ independent: 0,
      byClass: { action_channel: 1, independent_tests: 0, owner_reviews: 0, primary_official: 1 } });
  });

  it("counts two owner-review pages of one marketplace as one independent source", () => {
    const first = record("https://market.example.org/product-a/reviews", "Owners report lasting comfort.\n$249\nAdd to cart", { sourceClass: "owner_reviews" });
    const second = record("https://market.example.org/product-b/reviews", "Owners report broken springs.\n$349\nAdd to cart", { sourceClass: "owner_reviews" });
    expect(first.textGroupKey).not.toBe(second.textGroupKey);
    expect(quality.researchSourceCounts([first, second])).toEqual({ independent: 1,
      byClass: { action_channel: 0, independent_tests: 0, owner_reviews: 1, primary_official: 0 } });
  });

  it.each(["The tested mattress costs $249.", "Add to cart", 'The review says "Add to cart" beside a $249 price.', "Order statistics from 2024", "El colchón cuesta 499 € y se puede comprar en tiendas."])(
    "does not mistake a price, prose or a control alone for a shop: %s", (text) => {
      expect(quality.researchShopText(text)).toBe(false);
      expect(quality.countIndependentSources([record(URL, text)])).toBe(1);
    }
  );

  it("does not lose a shop signal when similar non-shop prose was recorded first", () => {
    const article = record();
    const shop = record("https://shop.net/product", `${RELEASE}\n$249\nAdd to cart`);
    const grouped = { ...shop, textGroupKey: quality.researchTextGroupKey(shop.textGroupKey, [article.textGroupKey]) };
    expect(quality.researchSourceClass(grouped, [article, grouped])).toBe("action_channel");
    expect(quality.countIndependentSources([article, grouped])).toBe(1);
  });
});

describe("publication dates and ages", () => {
  it.each<[string, string | null]>([
    ["Published: 2024", "2024"], ["Published on 2024-03", "2024-03"], ["Publication date: 2024-02-29", "2024-02-29"],
    ["Published: March 5, 2024", "2024-03-05"], ["Опубликовано: 5 марта 2024", "2024-03-05"], ["Published: March 2024", "2024-03"],
    ["Publicado el 5 de marzo de 2024", "2024-03-05"], ["Fecha de publicación: marzo de 2024", "2024-03"], ["Referencias\nPublicado: 2024-01-01", null],
    ["Published: 2024\nPublished: 2024-03-05", "2024-03-05"],
    ["The study was published in 2024.\nUpdated: 2026-11-02\nCopyright 2026", null],
    ["Published: 03/04/2024", null], ["Published: 2023-02-29", null], ["Published: 2024-13", null], ["Published: 2024-04-31", null],
    ["Published: yesterday", null], ["Published: 2024-01-01\nPublished: 2025-01-01", null],
    ["References:\nPublished: 2024-01-01", null], ["> Published: 2024-01-01", null], ["Published: 2024-01-01 in another journal", null],
    [`${"Article body.\n".repeat(21)}Published: 2024-01-01`, null]
  ])("extracts only an unambiguous page publication: %s", (text, expected) => {
    expect(quality.researchPublishedOn(text)).toBe(expected);
  });

  it.each<[string | null, string, number | null]>([
    ["2024-03-05", "2026-03-04", 23], ["2024-03-05", "2026-03-05", 24],
    ["2024-03", "2026-03-05", 23], ["2024", "2026-03-05", 14], ["2026", "2026-03-05", 0],
    ["2027", "2026-03-05", null], ["2026-03-06", "2026-03-05", null], ["2024-02-30", "2026-03-05", null], [null, "2026-03-05", null]
  ])("computes conservative whole-month age for %s at %s", (publishedOn, asOf, expected) => {
    expect(quality.researchSourceAgeMonths({ publishedOn }, new Date(`${asOf}T00:00:00Z`))).toBe(expected);
  });

  it("uses UTC and gives an invalid clock no age", () => {
    expect(quality.researchSourceAgeMonths({ publishedOn: "2024-03-05" }, new Date("2026-03-05T00:30:00+03:00"))).toBe(23);
    expect(quality.researchSourceAgeMonths({ publishedOn: "2024" }, new Date("invalid"))).toBeNull();
  });

  it("never attaches another page's date or text group to the cited link", () => {
    expect(quality.prepareResearchSourceQuality(input(), { text: "Published: 2024-01-01\n$249\nAdd to cart", url: "https://other.net" }))
      .toEqual({ publishedOn: null, registrableDomain: "example.org", textGroupKey: null });
    expect(quality.prepareResearchSourceQuality(input(), null)).toEqual({ publishedOn: null, registrableDomain: "example.org", textGroupKey: null });
  });
});

/** The fake implements only the Prisma operations the append uses; no client or database connection is created. */
function appendDatabase(full = false) {
  const evidence: ResearchEvidence[] = [];
  let locked = false;
  const client = {
    $queryRaw: vi.fn(async () => { locked = true; return [{ lock: "" }]; }),
    researchEvidence: {
      aggregate: vi.fn(async () => ({ _count: { _all: evidence.length }, _max: { sequence: evidence.length - 1 } })),
      create: vi.fn(async ({ data }: { data: Prisma.ResearchEvidenceUncheckedCreateInput }): Promise<ResearchEvidence> => {
        const row: ResearchEvidence = { authorName: null, authorThreadId: null, claim: null, criterionKey: null, pageId: null, publishedOn: null,
          quote: null, quoteCheck: null, quoteCheckReason: null, reason: null, registrableDomain: null, rowKey: null, sourceClass: null, standing: null,
          supersedesId: null, target: null, textGroupKey: null, url: null, id: `record-${evidence.length}`, ...data,
          createdAt: new Date("2026-11-02T00:00:00Z"), dataset: null };
        evidence.push(row);
        return row;
      }),
      findMany: vi.fn(async (args: Prisma.ResearchEvidenceFindManyArgs) => {
        expect(locked).toBe(true);
        const run = args.where?.modelRunId;
        const runIds = typeof run === "string" ? [run] : Array.isArray(run?.in) ? run.in : [];
        const seen = new Set<string | null>();
        return evidence.filter((row) => {
          if (row.userId !== args.where?.userId || row.chatId !== args.where?.chatId || !runIds?.includes(row.modelRunId) || row.textGroupKey === null) return false;
          if (seen.has(row.textGroupKey)) return false;
          seen.add(row.textGroupKey);
          return true;
        }).slice(0, args.take ?? evidence.length).map(({ textGroupKey }) => ({ textGroupKey }));
      })
    },
    researchPage: {
      findFirst: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _count: { _all: full ? RESEARCH_PAGE_LIMITS.pagesPerRun : 0 }, _sum: { sizeBytes: 0 } })),
      create: vi.fn(async () => ({ id: `page-${evidence.length}` }))
    }
  };
  const database = { ...client, $transaction: vi.fn(async (work: (tx: typeof client) => Promise<ResearchEvidenceWritten>) => {
    try { return await work(client); } finally { locked = false; }
  }) };
  const repository = createResearchEvidenceRepository(database as unknown as Parameters<typeof createResearchEvidenceRepository>[0]);
  return { database, evidence, isLocked: () => locked, repository };
}

describe("source quality in the store", () => {
  const scope = { chatId: "chat", researchRunId: "run", userId: "user" };
  const append = (url: string, text: string): ResearchEvidenceAppend => ({ author: { name: null, threadId: null }, chain: ["run"],
    page: { obtainedBy: "tool", text, truncated: false, url }, quoteCheck: { kept: { reason: null, status: "found" }, notKept: { reason: "page_not_stored", status: "not_checked" } },
    record: input(url), sourceQuality: quality.prepareResearchSourceQuality(input(url), { text, url }) });

  it("writes the three server columns and compares only bounded, scoped keys after the append lock", async () => {
    const memory = appendDatabase();
    const first = await memory.repository.append(scope, append(URL, `Published: 2024-03\nNew durability study released\n${RELEASE}`));
    const second = await memory.repository.append(scope, append("https://news.net/release", `Published: 2024-03\nMattress research findings announced\n${RELEASE}`));
    if (first.kind !== "recorded" || second.kind !== "recorded") throw new Error("The records must be accepted.");
    expect(first.record).toMatchObject({ publishedOn: "2024-03", registrableDomain: "example.org" });
    expect(second.record.textGroupKey).toBe(first.record.textGroupKey);
    expect(quality.countIndependentSources([first.record, second.record])).toBe(1);
    expect(memory.database.researchEvidence.findMany).toHaveBeenLastCalledWith({ distinct: ["textGroupKey"],
      orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }], select: { textGroupKey: true }, take: RESEARCH_PAGE_LIMITS.pagesPerRun,
      where: { chatId: "chat", modelRunId: { in: ["run"] }, textGroupKey: { not: null }, userId: "user" } });
  });

  it("uses a continued research's keys and never another owner's keys", async () => {
    const memory = appendDatabase();
    const first = await memory.repository.append(scope, append(URL, `New durability study released\n${RELEASE}`));
    const nextWrite = { ...append("https://news.net/release", `Mattress research findings announced\n${RELEASE}`), chain: ["run", "continued"] };
    const continued = await memory.repository.append({ ...scope, researchRunId: "continued" }, nextWrite);
    const other = await memory.repository.append({ ...scope, userId: "another" }, nextWrite);
    if (first.kind !== "recorded" || continued.kind !== "recorded" || other.kind !== "recorded") throw new Error("The records must be accepted.");
    expect(continued.record.textGroupKey).toBe(first.record.textGroupKey);
    expect(other.record.textGroupKey).toBe(nextWrite.sourceQuality.textGroupKey);
    expect(other.record.textGroupKey).not.toBe(first.record.textGroupKey);
  });

  it("keeps seller classification and accepts a record even when no page fits", async () => {
    const memory = appendDatabase(true);
    const written = await memory.repository.append(scope, append(URL, `${RELEASE}\n$249\nAdd to cart`));
    if (written.kind !== "recorded") throw new Error("The record must be accepted.");
    expect(written.record.pageId).toBeNull();
    expect(written.record.quoteCheck?.status).toBe("not_checked");
    expect(quality.countIndependentSources([written.record])).toBe(0);
  });

  it("computes page metadata before entering the repository transaction", async () => {
    const memory = appendDatabase();
    const text = `Published: 2024-03-05\n${RELEASE}`;
    const call = { arguments: { url: URL }, id: "call", observationId: null, providerCallId: "provider-call", toolName: "fetch_url",
      result: { callId: "provider-call", content: [{ type: "json", value: { finalUrl: URL, text, truncated: false } }], name: "fetch_url", status: "complete" } };
    const repository = { ...memory.repository, chain: async () => ["run"],
      agentCalls: () => ({ calls: async () => [call], fetchCalls: async () => [call], recentCalls: async () => [] }) };
    const original = quality.prepareResearchSourceQuality;
    const prepared = vi.spyOn(quality, "prepareResearchSourceQuality").mockImplementation((record, page) => {
      expect(memory.database.$transaction).not.toHaveBeenCalled();
      expect(memory.isLocked()).toBe(false);
      return original(record, page);
    });
    const run: ResearchRunScope = { ...scope, branchRunIds: [], extendTurn: () => undefined, now: () => 0, runId: "run", turnEndsAt: () => 0, sources: { opened: async () => [] },
      userFollowups: async () => [], userMessage: "Research." };
    const port = createResearchEvidenceStore({ repository, savedResults: { read: async () => null }, threads: { backgroundRunIds: async () => [] } })(run);
    const written = await port.record({ author: { name: null, threadId: null }, record: input() }, new AbortController().signal);
    expect(prepared).toHaveBeenCalledOnce();
    expect(written).toMatchObject({ kind: "recorded", record: { publishedOn: "2024-03-05", registrableDomain: "example.org", textGroupKey: expect.any(String) } });
  });

  it("gives every researcher the primary, measured and seller-source guidance", () => {
    const method = researcherMethodFooter({ goal: "Choose", questions: [], skipped: [] });
    for (const phrase of ["primary documents", "measured results", "seller's", "affiliate rating sites", "publication date"]) expect(method).toContain(phrase);
    expect(method).toContain("Owners' reviews on a shop page remain owner evidence");
    expect(method).toContain("maker documents remain primary sources");
  });
});
