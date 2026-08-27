import { describe, expect, it } from "vitest";
import { planMemoryRetrieval } from "./planner";

const now = new Date("2026-08-13T10:00:00.000Z");

describe("language-agnostic Memory retrieval planning", () => {
  it.each([
    "какие ответы я преподчитаю",
    "what do I prefer",
    "ما اسمي",
    "我的名字是什么",
    "मेरा नाम क्या है",
    "🧠::foo(){}",
    "\u00ff\u0101\u0001"
  ])("admits every bounded non-empty Unicode turn: %s", (currentUserText) => {
    const plan = planMemoryRetrieval({ currentUserText, now });
    expect(plan.queryPresent).toBe(true);
    expect(plan.normalizedQuery.length).toBeGreaterThan(0);
  });

  it("creates only a syntax-level simple lexical projection", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "  Какие\tответы — 我喜欢؟  ",
      now
    });
    expect(plan).toMatchObject({
      lexicalQuery: "Какие ответы 我喜欢",
      normalizedExactQuery: "какие ответы — 我喜欢؟",
      normalizedQuery: "Какие ответы — 我喜欢؟",
      originalSanitizedQuery: "Какие ответы — 我喜欢؟",
      queryPresent: true
    });
    expect(plan.semanticQueryVariants).toEqual([
      { kind: "ORIGINAL", text: "Какие ответы — 我喜欢؟" }
    ]);
    expect(plan.temporalQueryVariants).toEqual([
      { kind: "UNRESTRICTED", text: "Какие ответы — 我喜欢؟" }
    ]);
  });

  it("keeps the original first and adds a deduplicated planner rewrite", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "What did I call the Helsinki project?",
      entityMentions: [
        { occurrenceIndex: 0, resolvedRef: null, text: "Aurora" }
      ],
      now,
      semanticRewrite: "the Aurora codename for the Helsinki project"
    });

    expect(plan.originalSanitizedQuery).toBe("What did I call the Helsinki project?");
    expect(plan.semanticQueryVariants).toEqual([
      { kind: "ORIGINAL", text: "What did I call the Helsinki project?" },
      { kind: "PLANNER_REWRITE", text: "the Aurora codename for the Helsinki project" },
      { kind: "ENTITY_EXPANSION", text: "Aurora" }
    ]);
    expect(plan.lexicalQuery).toContain("What");
    expect(plan.lexicalQuery).toContain("Aurora");
  });

  it("deduplicates an equivalent rewrite without replacing the original", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "  My preferred editor  ",
      now,
      semanticRewrite: "my preferred editor"
    });
    expect(plan.semanticQueryVariants).toEqual([
      { kind: "ORIGINAL", text: "My preferred editor" }
    ]);
  });

  it("does not require lexical tokens to admit raw Unicode", () => {
    expect(planMemoryRetrieval({ currentUserText: "🧠✨", now })).toMatchObject({
      lexicalQuery: null,
      queryPresent: true
    });
  });

  it("carries only the trusted explicit recency decision", () => {
    expect(planMemoryRetrieval({ currentUserText: "latest update", now }))
      .toMatchObject({ recencyRequested: false });
    expect(planMemoryRetrieval({
      currentUserText: "latest update",
      now,
      recencyRequested: true
    })).toMatchObject({ recencyRequested: true });
  });

  it("carries the trusted broad-profile decision without inferring it from wording", () => {
    const broadLookingText = "расскажи всё, что ты знаешь обо мне";
    expect(planMemoryRetrieval({ currentUserText: broadLookingText, now }))
      .toMatchObject({ profileRequested: false });
    expect(planMemoryRetrieval({
      currentUserText: broadLookingText,
      filters: { sourceKinds: ["FACT", "EVENT"] },
      mode: "CURRENT_PROFILE",
      now,
      profileRequested: true
    })).toMatchObject({
      profileRequested: true,
      queryPresent: true,
      recencyRequested: false
    });
    expect(() => planMemoryRetrieval({
      currentUserText: broadLookingText,
      now,
      profileRequested: true,
      recencyRequested: true
    })).toThrow("memory_retrieval_plan_invalid");
    expect(() => planMemoryRetrieval({
      currentUserText: broadLookingText,
      now,
      profileRequested: "true" as never
    })).toThrow("memory_retrieval_plan_invalid");
  });

  it("carries only the trusted response-preference admission decision", () => {
    expect(planMemoryRetrieval({ currentUserText: "answer", now }))
      .toMatchObject({ applyResponsePreferences: false });
    expect(planMemoryRetrieval({
      applyResponsePreferences: true,
      currentUserText: "answer",
      filters: { sourceKinds: [] },
      now
    })).toMatchObject({
      applyResponsePreferences: true,
      filters: { sourceKinds: [] }
    });
    expect(() => planMemoryRetrieval({
      currentUserText: "answer",
      filters: { sourceKinds: [] },
      now
    })).toThrow("memory_retrieval_filter_invalid");
  });

  it("carries aggregation only on an explicit past-chat plan", () => {
    expect(planMemoryRetrieval({ currentUserText: "count prior events", now }))
      .toMatchObject({ aggregationRequested: false });
    expect(planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "all deployment rehearsals completed before launch day",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    })).toMatchObject({
      aggregationRequested: true,
      mode: "PAST_CHAT_SEARCH"
    });
    expect(() => planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "current preference",
      now
    })).toThrow("memory_retrieval_plan_invalid");
  });

  it("admits synthesis patterns only through an explicit targeted-current decision", () => {
    expect(planMemoryRetrieval({ currentUserText: "current workflow", now }))
      .toMatchObject({ includePatterns: false, mode: "TARGETED_CURRENT" });
    expect(planMemoryRetrieval({
      currentUserText: "current workflow",
      includePatterns: true,
      now
    })).toMatchObject({ includePatterns: true, mode: "TARGETED_CURRENT" });
    expect(() => planMemoryRetrieval({
      currentUserText: "profile",
      filters: { sourceKinds: ["FACT"] },
      includePatterns: true,
      mode: "CURRENT_PROFILE",
      now,
      profileRequested: true
    })).toThrow("memory_retrieval_plan_invalid");
    expect(() => planMemoryRetrieval({
      currentUserText: "past fact",
      filters: { sourceKinds: ["FACT"] },
      includePatterns: true,
      mode: "HISTORICAL_MEMORY",
      now,
      temporalIntent: "HISTORICAL"
    })).toThrow("memory_retrieval_plan_invalid");
    expect(() => planMemoryRetrieval({
      currentUserText: "current workflow",
      includePatterns: "true" as never,
      now
    })).toThrow("memory_retrieval_plan_invalid");
  });

  it("retains only exact entity occurrences and owner-validated opaque refs", () => {
    const longRef = `mr1.${"a".repeat(500)}`;
    const plan = planMemoryRetrieval({
      allowedEntityRefs: ["ref-acme", longRef],
      currentUserText: "Compare Acme with Acme",
      entityMentions: [
        { occurrenceIndex: 1, resolvedRef: "ref-acme", text: "Acme" },
        { occurrenceIndex: 2, resolvedRef: "ref-acme", text: "Acme" },
        { occurrenceIndex: 0, resolvedRef: "unowned-ref", text: "Compare" },
        { occurrenceIndex: 0, resolvedRef: longRef, text: "with" }
      ],
      now
    });

    expect(plan.entityMentions).toEqual([
      { occurrenceIndex: 1, resolvedRef: "ref-acme", text: "Acme" },
      { occurrenceIndex: 0, resolvedRef: null, text: "Compare" },
      { occurrenceIndex: 0, resolvedRef: longRef, text: "with" }
    ]);
    expect(() => planMemoryRetrieval({
      currentUserText: "Acme",
      entityMentions: [{ occurrenceIndex: -1, resolvedRef: null, text: "Acme" }],
      now
    })).toThrow("memory_retrieval_plan_invalid");
  });

  it("treats only an empty normalized turn as absent", () => {
    expect(planMemoryRetrieval({ currentUserText: " \n\t ", now }).queryPresent).toBe(false);
  });

  it("admits the deterministic ANY fallback for a mixed fact/history plan", () => {
    expect(planMemoryRetrieval({
      currentUserText: "What did we decide?",
      now,
      temporalIntent: "ANY"
    })).toMatchObject({
      mode: "TARGETED_CURRENT",
      temporalIntent: "ANY"
    });
  });

  it("accepts only explicit absolute typed filters", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    expect(planMemoryRetrieval({
      currentUserText: "query",
      filters: {
        from,
        scopeTargetId: "chat-1",
        scopeType: "CHAT",
        sourceKinds: ["EVENT", "FACT"],
        to
      },
      mode: "HISTORICAL_MEMORY",
      now,
      temporalIntent: "BETWEEN"
    }).filters).toEqual({
      asOf: null,
      from,
      scopeTargetId: "chat-1",
      scopeType: "CHAT",
      sourceKinds: ["EVENT", "FACT"],
      to
    });
    expect(() => planMemoryRetrieval({
      currentUserText: "query",
      filters: { from: to, to: from },
      now
    })).toThrow("memory_retrieval_filter_invalid");
  });

  it("adds deterministic temporal and unrestricted variants without model authority", () => {
    const temporal = planMemoryRetrieval({
      currentUserText: "What happened yesterday?",
      now: new Date("2026-01-01T01:30:00.000Z"),
      temporalIntent: "ANY",
      timeZone: "America/Los_Angeles"
    });
    expect(temporal.temporalQuery).toMatchObject({
      confidence: "HIGH",
      expressionType: "RELATIVE_DAY",
      matchedExpressionCount: 1,
      state: "MATCHED"
    });
    expect(temporal.temporalQuery.interval?.from?.toISOString())
      .toBe("2025-12-30T08:00:00.000Z");
    expect(temporal.temporalQueryVariants).toEqual([
      { kind: "FILTERED", text: "What happened yesterday?" },
      { kind: "UNRESTRICTED", text: "What happened yesterday?" }
    ]);
    expect(temporal.temporalQuery).not.toHaveProperty("text");
    expect(temporal.temporalQuery).not.toHaveProperty("query");
  });

  it("keeps medium and ambiguous temporal parsing fail-open", () => {
    const medium = planMemoryRetrieval({
      currentUserText: "on February 10",
      now,
      temporalIntent: "ANY"
    });
    expect(medium.temporalQuery).toMatchObject({ confidence: "MEDIUM", state: "MATCHED" });
    expect(medium.temporalQueryVariants.map(({ kind }) => kind))
      .toEqual(["FILTERED", "UNRESTRICTED"]);

    const ambiguous = planMemoryRetrieval({
      currentUserText: "03/04/2025",
      now,
      temporalIntent: "ANY"
    });
    expect(ambiguous.temporalQuery).toMatchObject({ state: "AMBIGUOUS", interval: null });
    expect(ambiguous.temporalQueryVariants.map(({ kind }) => kind))
      .toEqual(["UNRESTRICTED"]);
  });

  it("validates every explicit retrieval mode against source and temporal intent", () => {
    const facts = { sourceKinds: ["FACT", "EVENT"] as const };
    const history = { sourceKinds: ["HISTORY"] as const };
    expect(planMemoryRetrieval({
      currentUserText: "profile",
      filters: facts,
      mode: "CURRENT_PROFILE",
      now,
      profileRequested: true,
      temporalIntent: "CURRENT"
    }).mode).toBe("CURRENT_PROFILE");
    expect(planMemoryRetrieval({
      currentUserText: "current fact",
      filters: facts,
      mode: "TARGETED_CURRENT",
      now,
      temporalIntent: "CURRENT"
    }).mode).toBe("TARGETED_CURRENT");
    expect(planMemoryRetrieval({
      currentUserText: "past fact",
      filters: facts,
      mode: "HISTORICAL_MEMORY",
      now,
      temporalIntent: "HISTORICAL"
    }).mode).toBe("HISTORICAL_MEMORY");
    expect(planMemoryRetrieval({
      currentUserText: "past chat",
      filters: history,
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    }).mode).toBe("PAST_CHAT_SEARCH");
    expect(planMemoryRetrieval({
      currentUserText: "history overview",
      filters: history,
      mode: "HISTORY_OVERVIEW",
      now,
      temporalIntent: "ANY"
    }).mode).toBe("HISTORY_OVERVIEW");

    for (const invalid of [
      { filters: history, mode: "TARGETED_CURRENT", temporalIntent: "CURRENT" },
      { filters: facts, mode: "PAST_CHAT_SEARCH", temporalIntent: "ANY" },
      { filters: history, mode: "HISTORICAL_MEMORY", temporalIntent: "HISTORICAL" },
      { filters: facts, mode: "TARGETED_CURRENT", temporalIntent: "HISTORICAL" }
    ] as const) {
      expect(() => planMemoryRetrieval({
        currentUserText: "invalid cross-mode request",
        ...invalid,
        now
      })).toThrow("memory_retrieval_plan_invalid");
    }
  });
});
