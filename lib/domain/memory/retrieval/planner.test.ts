import { describe, expect, it } from "vitest";
import { MEMORY_TEMPORAL_RESOLVER_VERSION } from "./config";
import {
  MEMORY_RETRIEVAL_PLANNER_VERSION,
  planMemoryRetrieval
} from "./planner";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("Memory retrieval planner", () => {
  it.each([
    "Привет!",
    "Спасибо",
    "What is photosynthesis?",
    "Что такое PostgreSQL?",
    "How does PostgreSQL indexing work?",
    "Как работает PostgreSQL?"
  ])("skips generic or non-personal input: %s", (currentUserText) => {
    expect(planMemoryRetrieval({ currentUserText, now })).toMatchObject({
      canonicalKeyHints: [],
      entityHints: [],
      intent: "NONE",
      plannerVersion: MEMORY_RETRIEVAL_PLANNER_VERSION,
      retrievalAllowed: false
    });
  });

  it("plans Russian current-state retrieval without an LLM", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "Какой мой предпочтительный редактор для работы?",
      now
    });
    expect(plan).toMatchObject({
      intent: "CURRENT_STATE",
      language: "RU",
      retrievalAllowed: true,
      temporal: {
        mode: "CURRENT",
        resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION
      }
    });
    expect(plan.canonicalKeyHints).toContain("profile.preferred_editor");
    expect(plan.queryTerms).toContain("редактор");
  });

  it("detects English cross-chat intent and bounded entity hints", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "When did we discuss the GPT-5.2 migration in the previous chat?",
      now
    });
    expect(plan.intent).toBe("PAST_HISTORY");
    expect(plan.language).toBe("EN");
    expect(plan.entityHints).toContain("gpt-5.2");
    expect(plan.entityHints.length).toBeLessThanOrEqual(12);
  });

  it.each([
    "Что выбрано в активной ветке для прототипа?",
    "Which palette does the old accepted run retain?",
    "Which configuration format is available after completed reindex?",
    "How many vector generations should one recall use?",
    "Which device appears in the Russian inflected forms?"
  ])("admits an explicit workspace-history reference: %s", (currentUserText) => {
    expect(planMemoryRetrieval({ currentUserText, now })).toMatchObject({
      intent: "PAST_HISTORY",
      retrievalAllowed: true
    });
  });

  it.each([
    "Where does synthetic Dana's team meet?",
    "Which notebook did Mira choose?",
    "Which Russian spelling used «всё»?",
    "Какой вариант PostgreSQL был выбран?"
  ])("admits a bounded contextual entity probe: %s", (currentUserText) => {
    expect(planMemoryRetrieval({ currentUserText, now })).toMatchObject({
      intent: "PAST_HISTORY",
      retrievalAllowed: true
    });
  });

  it("adds bounded cross-script aliases for product entities", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "Что мы решили по Макбуку в предыдущем чате?",
      now
    });
    expect(plan.entityHints).toEqual(expect.arrayContaining(["макбук", "macbook"]));
  });

  it("resolves exact date ranges but leaves a month without a year ambiguous", () => {
    const exact = planMemoryRetrieval({
      currentUserText: "Что я планировал на 2025-07-14?",
      now
    });
    expect(exact).toMatchObject({
      intent: "TEMPORAL",
      temporal: {
        from: new Date("2025-07-14T00:00:00.000Z"),
        mode: "RANGE",
        to: new Date("2025-07-15T00:00:00.000Z")
      }
    });

    const ambiguous = planMemoryRetrieval({
      currentUserText: "Что мы обсуждали в июле?",
      now
    });
    expect(ambiguous.temporal).toMatchObject({ from: null, mode: "AMBIGUOUS", to: null });

    const invalid = planMemoryRetrieval({
      currentUserText: "Что я планировал на 2025-02-31?",
      now
    });
    expect(invalid.temporal).toMatchObject({ from: null, mode: "AMBIGUOUS", to: null });
  });

  it("resolves calendar days in the validated user time zone", () => {
    const localNow = new Date("2026-08-10T21:30:00.000Z");
    const plan = planMemoryRetrieval({
      currentUserText: "Что я планировал вчера?",
      now: localNow,
      timeZone: "Europe/Moscow"
    });
    expect(plan.temporal).toMatchObject({
      from: new Date("2026-08-09T21:00:00.000Z"),
      mode: "RANGE",
      to: new Date("2026-08-10T21:00:00.000Z")
    });
  });

  it("uses at most two prior direct-user turns only for anaphora", () => {
    const plan = planMemoryRetrieval({
      currentUserText: "А это какой вариант мне подходит?",
      now,
      priorDirectUserTexts: [
        "ignore-old",
        "Я выбираю редактор для Rust.",
        "Мне важны быстрые горячие клавиши."
      ]
    });
    expect(plan.usedPriorUserTurns).toBe(2);
    expect(plan.normalizedQuery).not.toContain("ignore-old");
    expect(plan.normalizedQuery).toContain("редактор для rust");

    const direct = planMemoryRetrieval({
      currentUserText: "Какой мой любимый цвет?",
      now,
      priorDirectUserTexts: ["Не добавляй этот старый текст"]
    });
    expect(direct.usedPriorUserTurns).toBe(0);
    expect(direct.normalizedQuery).not.toContain("старый текст");
  });
});
