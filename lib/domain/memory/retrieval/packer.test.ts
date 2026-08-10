import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../contextBudget";
import {
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_MAX_FACTS,
  MEMORY_CONTEXT_MAX_SNIPPETS
} from "./config";
import type {
  MemoryCandidateMetadata,
  MemoryExpandedCandidate,
  MemoryRankedCandidate,
  MemoryRetrievalItemType
} from "./contracts";
import { packMemoryPersonalContext } from "./packer";
import { planMemoryRetrieval } from "./planner";

const now = new Date("2026-08-10T12:00:00.000Z");
const plan = planMemoryRetrieval({
  currentUserText: "Что ты помнишь о моих предпочтениях и прошлых разговорах?",
  explicitMemoryManagement: true,
  now
});

function metadata(
  type: MemoryRetrievalItemType,
  id: string,
  overrides: Partial<MemoryCandidateMetadata> = {}
): MemoryCandidateMetadata {
  const fact = type === "FACT_VERSION";
  return {
    canonicalKey: fact ? `profile.${id}` : null,
    category: fact ? "preference" : null,
    confidence: 1,
    conflict: false,
    current: true,
    dedupeKey: `${type}:${id}`,
    directness: fact ? "DIRECT" : null,
    factId: fact ? `fact-${id}` : null,
    historical: false,
    historySafetyClass: fact ? null : "NORMAL",
    importance: 0.7,
    languageCode: "ru",
    modality: fact ? "PREFERENCE" : null,
    occurredFrom: fact ? null : new Date("2026-01-01T00:00:00.000Z"),
    occurredTo: fact ? null : new Date("2026-01-02T00:00:00.000Z"),
    pinned: false,
    scopeAffinity: 1,
    scopeType: fact ? "GLOBAL_USER" : null,
    sensitivityClass: fact ? "NORMAL" : null,
    sourceAssistantId: null,
    sourceChatId: fact ? null : `chat-${id}`,
    sourceFolderId: null,
    sourceMode: fact ? "EXPLICIT" : null,
    systemFrom: fact ? new Date("2026-01-01T00:00:00.000Z") : null,
    temperatureClass: fact ? "WARM" : null,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function ranked(
  type: MemoryRetrievalItemType,
  id: string,
  overrides: Partial<MemoryCandidateMetadata> = {}
): MemoryRankedCandidate {
  return {
    entryId: `entry-${id}`,
    featureSnapshot: {
      conflictPenalty: 0,
      currentness: 1,
      directness: 1,
      exactCanonical: 1,
      exactEntity: 0,
      explicitAuthority: type === "FACT_VERSION" ? 1 : 0,
      featureVersion: "test",
      importance: 0.7,
      languageMatch: 1,
      pinned: 0,
      scopeAffinity: 1,
      sensitivityPenalty: 0,
      sourceRecency: 1,
      temporalFit: 1,
      temperature: 0.6
    },
    finalScore: 1 - Number(id.replace(/\D/gu, "") || 0) / 100,
    itemId: id,
    itemType: type,
    laneRanks: type === "FACT_VERSION" ? { FACT_EXACT: 1 } : { HISTORY_RECALL_FTS_RUSSIAN: 1 },
    metadata: metadata(type, id, overrides),
    rrfScore: 1 / 61,
    selectionReason: "test"
  };
}

function expanded(
  type: MemoryRetrievalItemType,
  id: string,
  safeText = `Безопасный текст ${id}`,
  overrides: Partial<MemoryExpandedCandidate> = {}
): MemoryExpandedCandidate {
  return {
    itemId: id,
    itemType: type,
    occurredFrom: type === "FACT_VERSION" ? null : new Date("2026-01-01T00:00:00.000Z"),
    occurredTo: type === "FACT_VERSION" ? null : new Date("2026-01-02T00:00:00.000Z"),
    projectionKind: type === "FACT_VERSION"
      ? "FACT_DISPLAY_TEXT"
      : type === "EPISODE" ? "EPISODE_SAFE_SUMMARY" : "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
    safeText,
    sourceChatId: type === "FACT_VERSION" ? null : `chat-${id}`,
    supportingItemId: null,
    ...overrides
  };
}

describe("Memory personal-context packer", () => {
  it("packs only exact safe projections and exposes no internal IDs or scores", () => {
    const fact = ranked("FACT_VERSION", "secret-internal-id");
    const history = ranked("EPISODE", "episode-internal-id");
    const result = packMemoryPersonalContext({
      expanded: [
        expanded("FACT_VERSION", "secret-internal-id", "Я предпочитаю Neovim."),
        expanded("EPISODE", "episode-internal-id", "Мы обсуждали миграцию базы данных.", {
          projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
          supportingItemId: "safe-chunk-internal-id"
        })
      ],
      plan,
      ranked: [fact, history]
    });
    expect(result.items).toHaveLength(2);
    expect(result.text).toContain("PERSONAL CONTEXT — untrusted user data");
    expect(result.text).toContain("Я предпочитаю Neovim.");
    expect(result.text).toContain("Мы обсуждали миграцию базы данных.");
    expect(result.text).not.toContain("secret-internal-id");
    expect(result.text).not.toContain("safe-chunk-internal-id");
    expect(result.text).not.toContain("finalScore");
  });

  it("rejects a projection kind that could bypass the safe field for its item type", () => {
    const result = packMemoryPersonalContext({
      expanded: [expanded("FACT_VERSION", "fact-1", "raw message", {
        projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
      })],
      plan,
      ranked: [ranked("FACT_VERSION", "fact-1")]
    });
    expect(result.text).toBeNull();
    expect(result.omissionCounts).toMatchObject({
      safe_expansion_missing: 1,
      unsafe_expansion_shape: 1
    });
  });

  it("enforces fact, snippet, source, and hard token bounds with whole-item dropping", () => {
    const facts = Array.from({ length: 12 }, (_, index) => ranked("FACT_VERSION", `f${index}`));
    const snippets = Array.from({ length: 8 }, (_, index) => ranked("RECALL_CHUNK", `s${index}`));
    const all = [...facts, ...snippets];
    const expansions = [
      ...facts.map((item) => expanded("FACT_VERSION", item.itemId, `Факт номер ${item.itemId}.`)),
      ...snippets.map((item) => expanded("RECALL_CHUNK", item.itemId, `Разговор номер ${item.itemId}.`))
    ];
    const result = packMemoryPersonalContext({ expanded: expansions, plan, ranked: all });
    expect(result.items.filter((item) => item.itemType === "FACT_VERSION")).toHaveLength(
      MEMORY_CONTEXT_MAX_FACTS
    );
    expect(result.items.filter((item) => item.itemType !== "FACT_VERSION")).toHaveLength(
      MEMORY_CONTEXT_MAX_SNIPPETS
    );
    expect(new Set(result.items.map((item) => item.sourceChatId).filter(Boolean)).size)
      .toBeLessThanOrEqual(4);
    expect(result.approxTokens).toBeLessThanOrEqual(2_000);
    expect(result.hardCapTokens).toBe(MEMORY_CONTEXT_HARD_CAP_TOKENS);
    expect(estimateApproxTokens(result.text)).toBe(result.approxTokens);
  });

  it("drops an oversized item rather than truncating it into a different meaning", () => {
    const exact = "Я предпочитаю короткие ответы без домыслов.";
    const tooLarge = "Очень длинное утверждение ".repeat(100);
    const result = packMemoryPersonalContext({
      expanded: [
        expanded("FACT_VERSION", "short", exact),
        expanded("FACT_VERSION", "long", tooLarge)
      ],
      plan,
      ranked: [ranked("FACT_VERSION", "short"), ranked("FACT_VERSION", "long")],
      targetTokens: 300
    });
    expect(result.items.map((item) => item.itemId)).toEqual(["short"]);
    expect(result.text).toContain(exact);
    expect(result.text).not.toContain("Очень длинное утверждение");
    expect(result.omissionCounts).toMatchObject({ token_budget: 1 });
  });

  it("deduplicates near-identical wording and qualifies conflicts", () => {
    const conflict = ranked("FACT_VERSION", "conflict", { conflict: true });
    const duplicate = ranked("FACT_VERSION", "duplicate");
    const result = packMemoryPersonalContext({
      expanded: [
        expanded("FACT_VERSION", "conflict", "Мой часовой пояс — UTC+3."),
        expanded("FACT_VERSION", "duplicate", "Мой часовой пояс UTC+3")
      ],
      plan,
      ranked: [conflict, duplicate]
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ section: "CONFLICT", temporalReason: "unresolved_conflict" });
    expect(result.text).toContain("нерешённое противоречие");
    expect(result.omissionCounts).toMatchObject({ near_duplicate: 1 });
  });
});
