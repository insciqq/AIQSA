import { describe, expect, it } from "vitest";
import {
  RESEARCH_STEPS_MAX, RESEARCH_TOOL_NAMES, answerFirstParagraph, answerRaceLanding, answerStreamFacts, createSseReader, oracleU, parseResearchSteps,
  researchBotCheckOutcomes, researchBotChecks, researchCost, researchEarlierOutcomes, researchFinalSummary, researchPageCard, researchPageEntry,
  researchPriorityEvidence, researchRatingsEvidence, researchSendBacks, researchStepVerdict, researchUnreachableEvidence, textNamesCount, textNamesScore,
  type ResearchFetchRow, type ResearchRecordRow, type SseEvent
} from "./research-review-support";

describe("T's steps file", () => {
  it("reads a list of texts with their Deep research choice, exactly those keys", () => {
    expect(parseResearchSteps(JSON.stringify([{ text: "А дешевле?", deepResearch: false }, { deepResearch: true, text: "Сравни ещё раз" }])))
      .toEqual([{ deepResearch: false, text: "А дешевле?" }, { deepResearch: true, text: "Сравни ещё раз" }]);
  });

  it("refuses anything else by code, never echoing the text", () => {
    for (const raw of ["", "{}", "[]", "not json", JSON.stringify([{ text: "x" }]), JSON.stringify([{ text: "x", deepResearch: "yes" }]),
      JSON.stringify([{ text: "  ", deepResearch: false }]), JSON.stringify([{ text: "x", deepResearch: false, extra: 1 }]),
      JSON.stringify([{ text: "x".repeat(8_001), deepResearch: false }])]) {
      expect(() => parseResearchSteps(raw)).toThrow(/^research_steps_invalid$/u);
    }
    expect(() => parseResearchSteps(JSON.stringify(Array.from({ length: RESEARCH_STEPS_MAX + 1 }, () => ({ text: "x", deepResearch: false })))))
      .toThrow("research_steps_too_many");
  });

  it("passes an ordinary step only when nothing of research was offered, called or written and the run completed", () => {
    const quiet = { frame: false, offered: false, researchCalls: 0, started: false, status: "complete" };
    expect(researchStepVerdict({ deepResearch: false }, quiet)).toEqual({ failed: [], ok: true });
    expect(researchStepVerdict({ deepResearch: false }, { ...quiet, offered: true, researchCalls: 2, started: true, frame: true, status: "error" }).failed)
      .toEqual(["research_offered", "research_tool_called", "research_frame_written", "run_error"]);
  });

  it("passes a Deep research step only when research was offered, started and framed, and the run completed", () => {
    const ran = { frame: true, offered: true, researchCalls: 9, started: true, status: "complete" };
    expect(researchStepVerdict({ deepResearch: true }, ran).ok).toBe(true);
    expect(researchStepVerdict({ deepResearch: true }, { ...ran, offered: false, started: false, frame: false, status: "harness_timeout" }).failed)
      .toEqual(["research_not_offered", "research_not_started", "research_frame_missing", "run_harness_timeout"]);
    expect(RESEARCH_TOOL_NAMES).toContain("start_research");
  });
});

describe("the research page", () => {
  const card = (extra: Record<string, unknown>) => ({ artifactType: "generated_artifact", payload: { artifact_id: "a1", version_id: "v1", version_number: 1,
    kind: "html", title: "Synthetic page", entrypoint: "index.html", ...extra } });

  it("finds the card with the research marker, in either form, and ignores plain artifacts", () => {
    expect(researchPageCard([card({})])).toBeNull();
    expect(researchPageCard([{ artifactType: "image", payload: {} }, card({ research_page: { summary_end: 120, notes_start: null } })]))
      .toEqual({ artifactId: "a1", entrypoint: "index.html", notesStart: null, summaryEnd: 120, title: "Synthetic page", versionId: "v1" });
  });

  it("takes the entry page's HTML from the source route, else the first HTML file", () => {
    const source = { versionId: "v1", files: [{ path: "app.js", text: "x" }, { path: "page.html", text: "<p>b</p>" }, { path: "index.html", text: "<p>a</p>" }] };
    expect(researchPageEntry(source, "index.html")).toEqual({ html: "<p>a</p>", path: "index.html", paths: ["app.js", "page.html", "index.html"] });
    expect(researchPageEntry({ files: [{ path: "page.html", text: "<p>b</p>" }] }, "index.html")?.path).toBe("page.html");
    expect(researchPageEntry({ files: [{ path: "index.html", binary: true }] }, null)).toBeNull();
    expect(researchPageEntry(null, null)).toBeNull();
  });
});

const fetchRow = (id: string, url: string, extra: Partial<ResearchFetchRow> = {}): ResearchFetchRow => ({ at: "2026-11-06T10:00:00Z", closedRefusal: false,
  error: null, httpStatus: null, id, read: false, threadId: "t1", url, ...extra });
const recordRow = (id: string, kind: string, extra: Partial<ResearchRecordRow> = {}): ResearchRecordRow => ({ at: "2026-11-06T10:05:00Z", criterionKey: null, id,
  kind, rating: null, reason: null, rowKey: null, target: null, url: null, ...extra });

describe("bot checks and closed sites", () => {
  it("reads only a 200 refused as fetch_http_status as a bot check, and follows each to a browser try, a closing or a read", () => {
    const fetches = [
      fetchRow("f1", "https://www.shop.example/item", { error: "fetch_http_status", httpStatus: 200 }),
      fetchRow("f2", "https://other.example/a", { error: "fetch_http_status", httpStatus: 403 }),
      fetchRow("f3", "https://market.example/b", { error: "fetch_http_status", httpStatus: 200, threadId: null }),
      fetchRow("f4", "https://market.example/c", { at: "2026-11-06T10:10:00Z", read: true })
    ];
    const checks = researchBotChecks(fetches);
    expect(checks.map((check) => [check.callId, check.host])).toEqual([["f1", "shop.example"], ["f3", "market.example"]]);
    const records = [recordRow("r1", "unreachable", { target: "shop.example", reason: "CAPTCHA in the browser" })];
    const outcome = researchBotCheckOutcomes(checks, new Map([["f1", true]]), records, fetches);
    expect(outcome.full).toEqual([
      { agent: "subagent", browserAfter: true, host: "shop.example", laterRead: false, laterUnreachable: true },
      { agent: "main", browserAfter: false, host: "market.example", laterRead: true, laterUnreachable: false }
    ]);
    expect(outcome.counts).toEqual({ botChecks: 2, hosts: 2, browserAfter: 1, laterUnreachable: 1, laterRead: 1, neither: 0 });
  });

  it("names a sibling host of the same registrable domain refused as closed after the closing, and only that", () => {
    const records = [recordRow("r1", "unreachable", { target: "https://shop.portal.example/x", reason: "blocked" })];
    const fetches = [
      fetchRow("f1", "https://news.portal.example/", { at: "2026-11-06T10:06:00Z", closedRefusal: true }),
      fetchRow("f2", "https://shop.portal.example/y", { at: "2026-11-06T10:07:00Z", closedRefusal: true }),
      fetchRow("f3", "https://maps.portal.example/", { at: "2026-11-06T10:01:00Z", closedRefusal: true })
    ];
    const evidence = researchUnreachableEvidence(records, fetches);
    expect(evidence.full).toEqual([{ host: "shop.portal.example", reason: "blocked", siblingHosts: ["news.portal.example"], siblingRefusedAsClosed: true }]);
    expect(evidence.counts).toEqual({ closedRefusals: 3, hosts: 1, siblingRefusedAsClosed: 1, unreachable: 1 });
    expect(researchUnreachableEvidence(records, fetches.slice(1)).counts.siblingRefusedAsClosed).toBe(0);
  });
});

describe("the final draft's summary, ratings and priorities", () => {
  const drafts = [
    { report: "r", pick_row_key: "alpha", summary: { text: "Alpha: 4,8 из 5 по 12 345 оценкам.", row_keys: ["alpha", "beta"],
      priorities: [{ criterion_key: "value", text: "Дешевле Beta на 10%." }] } },
    { edits: [{ find: "a", replace: "b" }] }
  ];

  it("keeps the summary an edit leaves out, and takes the pick from the draft, else the summary's first row", () => {
    expect(researchFinalSummary(drafts)).toEqual({ pickRowKey: "alpha", priorities: [{ criterionKey: "value", text: "Дешевле Beta на 10%." }],
      rowKeys: ["alpha", "beta"], text: "Alpha: 4,8 из 5 по 12 345 оценкам." });
    expect(researchFinalSummary([{ summary: { text: "x", row_keys: ["beta"] } }])?.pickRowKey).toBe("beta");
    expect(researchFinalSummary([{ report: "no summary" }])).toBeNull();
  });

  it("matches a score with a point or a comma and a count however it is grouped, never inside another number", () => {
    expect(textNamesScore("оценка 4,8", 4.8)).toBe(true);
    expect(textNamesScore("rated 4.8/5", 4.8)).toBe(true);
    expect(textNamesScore("rated 4.85", 4.8)).toBe(false);
    expect(textNamesCount("12 345 оценок", 12_345)).toBe(true);
    expect(textNamesCount("12,345 ratings", 12_345)).toBe(true);
    expect(textNamesCount("112345", 12_345)).toBe(false);
  });

  it("lists the ratings with their platform and says whether the summary names the pick's", () => {
    const records = [
      recordRow("r1", "finding", { rowKey: "alpha", url: "https://www.market.example/p/1", rating: { score: 4.8, scaleMax: 5, count: 12_345, counted: "ratings", variantsMerged: false } }),
      recordRow("r2", "finding", { rowKey: "beta", url: "https://reviews.example/b", rating: { score: 4.1, scaleMax: 5, count: 30, counted: "reviews", variantsMerged: true } }),
      recordRow("r3", "finding", { rowKey: "alpha", url: "https://maker.example/" })
    ];
    const evidence = researchRatingsEvidence(records, researchFinalSummary(drafts));
    expect(evidence.counts).toEqual({ ratings: 2, rows: 2, platforms: 2, pickRatings: 1, summaryNamesPickScore: true, summaryNamesPickCount: true });
    expect(evidence.full.ratings[0]).toMatchObject({ platform: "market.example", rowKey: "alpha", score: 4.8 });
    expect(researchRatingsEvidence(records, null).counts).toMatchObject({ pickRatings: 0, summaryNamesPickScore: false });
  });

  it("answers the plan's priorities from the final summary's lines", () => {
    const frame = { criteria: [{ key: "value", criterion: "Цена и качество", priority: true }, { key: "quiet", criterion: "Тишина", priority: true },
      { key: "ratings", criterion: "Оценки", ratings: true }, { key: "size", criterion: "Размер" }] };
    const evidence = researchPriorityEvidence(frame, researchFinalSummary(drafts));
    expect(evidence.counts).toEqual({ priorities: 2, answered: 1, answeredOther: 0, allAnswered: false, ratingsCriterion: true });
    expect(evidence.full.unanswered).toEqual(["quiet"]);
    expect(researchPriorityEvidence({ criteria: [] }, null).counts).toMatchObject({ priorities: 0, allAnswered: true, ratingsCriterion: false });
  });
});

describe("send-backs, earlier options and cost", () => {
  it("keeps each send-back with its gate and counts those naming disagreeing sites", () => {
    const evidence = researchSendBacks([{ status: "accepted" }, { status: "sent_back", gate: "report_check", message: "Two sites give different figures for a key specification" },
      { status: "sent_back", gate: "verifier", message: "C3 is unsupported" }, null]);
    expect(evidence.counts).toEqual({ sentBack: 2, byGate: { report_check: 1, verifier: 1 }, mentioningDisagreement: 1 });
    expect(evidence.full[1]).toEqual({ gate: "verifier", message: "C3 is unsupported" });
  });

  it("says what became of each option earlier research seeded: a row, a set-aside with its reason, or open", () => {
    const frame = {
      rows: [{ key: "alpha-one", label: "Alpha One 160x200" }],
      setAside: [{ at: "t", key: "beta-two", reason: "discontinued" }],
      candidates: [
        { key: "alpha-one", label: "Alpha One", earlier: { on: "2026-11-05", pick: true }, notes: [] },
        { key: "beta-two", label: "Beta Two", earlier: { on: "2026-11-05" }, notes: [] },
        { key: "gamma", label: "Gamma", earlier: { on: "2026-11-05" }, notes: [] },
        { key: "delta", label: "Delta", notes: [] }
      ]
    };
    const evidence = researchEarlierOutcomes(frame);
    expect(evidence.full.map((entry) => [entry.key, entry.became, entry.reason])).toEqual([["alpha-one", "row", null], ["beta-two", "set_aside", "discontinued"],
      ["gamma", "open", null]]);
    expect(evidence.counts).toEqual({ earlier: 3, earlierPick: 1, rows: 1, setAside: 1, open: 1 });
    expect(researchEarlierOutcomes(null).counts.earlier).toBe(0);
  });

  it("sums a cost only where the rows hold one and says when none does", () => {
    expect(researchCost([])).toMatchObject({ status: "not_available", micros: null });
    expect(researchCost([{ costReported: false, estimatedCostMicros: null }])).toMatchObject({ status: "not_available", micros: null, rows: 1 });
    expect(researchCost([{ costReported: true, estimatedCostMicros: 1_500 }, { costReported: false, estimatedCostMicros: null }]))
      .toMatchObject({ status: "partial", micros: 1_500, withCost: 1, reported: 1 });
    expect(researchCost([{ costReported: true, estimatedCostMicros: 1_500 }, { costReported: true, estimatedCostMicros: 500 }])).toMatchObject({ status: "available", micros: 2_000 });
  });
});

describe("U: the answer race", () => {
  const paragraph = "Холодильник переносит тепло изнутри наружу. Хладагент испаряется в испарителе и забирает тепло у продуктов. Компрессор сжимает его, и тепло уходит через конденсатор.";
  const event = (at: number, type: string, data: unknown): SseEvent => ({ at, data, type });

  it("reads SSE events across chunks and skips comments", () => {
    let now = 0;
    const reader = createSseReader(() => ++now);
    expect(reader.push(": keepalive\n\nevent: token\ndata: {\"delta\":\"Hi")).toEqual([]);
    expect(reader.push("\"}\n\nevent: done\ndata: {\"runId\":\"r\"}\n\n")).toEqual([{ at: 1, data: { delta: "Hi" }, type: "token" }, { at: 2, data: { runId: "r" }, type: "done" }]);
  });

  it("takes the first real paragraph, past a short line and a heading", () => {
    expect(answerFirstParagraph(`Запускаю.\n\n# Как работает\n\n${paragraph}\n\nДальше.`)).toBe(paragraph);
    expect(answerFirstParagraph("Коротко.")).toBeNull();
  });

  it("tells a reset that resends the text from one that rewrote it", () => {
    const resend = answerStreamFacts([event(1, "token", { delta: `${paragraph}\n\n` }), event(2, "message_reset", { round: 1 }),
      event(3, "token", { delta: `${paragraph}\n\nДобавка.` }), event(4, "answer_complete", {})]);
    expect(resend).toMatchObject({ endAt: 4, firstParagraph: paragraph, firstTokenAt: 1, resetsAfterText: 1, rewritten: 0, tokenTimes: [1, 3] });
    const rewrite = answerStreamFacts([event(1, "token", { delta: paragraph }), event(2, "message_reset", { round: 1 }), event(3, "token", { delta: "Готово." })]);
    expect(rewrite).toMatchObject({ resetsAfterText: 1, rewritten: 1 });
    expect(answerStreamFacts([event(1, "message_reset", { round: 0 }), event(2, "token", { delta: paragraph })])).toMatchObject({ resetsAfterText: 0, rewritten: 0 });
  });

  it("places the callback against the streaming text", () => {
    const tokens = [10_000, 10_500, 11_000, 11_500, 12_000];
    expect(answerRaceLanding({ callbackAt: null, intoRun: false, tokenTimes: tokens })).toBe("none");
    expect(answerRaceLanding({ callbackAt: 11_200, intoRun: true, tokenTimes: tokens })).toBe("during_answer");
    expect(answerRaceLanding({ callbackAt: 9_000, intoRun: true, tokenTimes: tokens })).toBe("before_answer");
    expect(answerRaceLanding({ callbackAt: 13_000, intoRun: true, tokenTimes: tokens })).toBe("after_answer");
    expect(answerRaceLanding({ callbackAt: 13_000, intoRun: true, tokenTimes: [...tokens, 20_000] })).toBe("after_answer");
    expect(answerRaceLanding({ callbackAt: 11_200, intoRun: false, tokenTimes: tokens })).toBe("after_answer");
  });

  it("fails a lost paragraph, a rewrite, an addition before the answer or an unfinished run, and marks an order not reached apart", () => {
    const good = { landing: "during_answer" as const, paragraphKept: true, resetsAfterText: 0, rewritten: 0, status: "complete", word: "after" as const };
    expect(oracleU(good)).toEqual({ failed: [], orderNotReached: false });
    expect(oracleU({ ...good, landing: "after_answer", word: "absent" })).toEqual({ failed: [], orderNotReached: true });
    expect(oracleU({ ...good, paragraphKept: false, rewritten: 1, status: "error", word: "before" }).failed)
      .toEqual(["run_not_complete", "paragraph_lost", "answer_rewritten", "addition_before_answer"]);
    expect(oracleU({ ...good, paragraphKept: null }).failed).toEqual(["paragraph_not_streamed"]);
  });
});
