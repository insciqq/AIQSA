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
      queryPresent: true
    });
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

  it("treats only an empty normalized turn as absent", () => {
    expect(planMemoryRetrieval({ currentUserText: " \n\t ", now }).queryPresent).toBe(false);
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
