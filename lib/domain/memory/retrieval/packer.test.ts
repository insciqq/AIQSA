import { describe, expect, it } from "vitest";
import { planMemoryRetrieval } from "./planner";
import { packMemoryPersonalContext } from "./packer";
import type {
  MemoryCandidateMetadata,
  MemoryCoreCandidate,
  MemoryExpandedCandidate,
  MemoryRankedCandidate
} from "./contracts";

const now = new Date("2026-08-13T10:00:00.000Z");
const plan = planMemoryRetrieval({
  applyResponsePreferences: true,
  currentUserText: "query",
  now
});
const profilePlan = planMemoryRetrieval({
  currentUserText: "what do you know about me",
  filters: { sourceKinds: ["FACT", "EVENT"] },
  now,
  profileRequested: true
});
const historicalPlan = planMemoryRetrieval({
  currentUserText: "how did my editor preference change",
  filters: { sourceKinds: ["FACT", "EVENT"] },
  mode: "HISTORICAL_MEMORY",
  now,
  temporalIntent: "HISTORICAL"
});
const aggregationPlan = planMemoryRetrieval({
  aggregationRequested: true,
  currentUserText: "all deployment rehearsals completed before launch day",
  filters: { sourceKinds: ["HISTORY"] },
  mode: "PAST_CHAT_SEARCH",
  now,
  temporalIntent: "ANY"
});

function metadata(
  id: string,
  history = false,
  sourceChatId = "chat-source"
): MemoryCandidateMetadata {
  return {
    canonicalKey: null, category: history ? null : "preferences", confidence: 0,
    conflict: false,
    coreEligible: !history, coreSalience: history ? "NONE" : "HIGH", current: true,
    dedupeKey: id, directness: history ? null : "DIRECT", dimensionKey: null,
    entityIds: [], expectedAt: null, expiresAt: null, factId: history ? null : id,
    historical: false, historySafetyClass: history ? "NORMAL" : null, importance: 0,
    identityKind: history ? null : "PROPOSITION", languageCode: "und",
    lastConfirmedAt: null, lastUsedAt: null,
    lifecycleState: history ? null : "ACTIVE", matchedEntityRole: null,
    modality: history ? null : "PREFERENCE", observedAt: null, occurredAt: null,
    occurredFrom: null,
    occurredTo: null, pinned: false, scopeAffinity: 0, scopeType: history ? null : "GLOBAL_USER",
    predicateKey: null, relationDepth: 0,
    sensitivityClass: history ? null : "NORMAL", sourceAssistantId: null,
    sourceChatId: history ? sourceChatId : null, sourceFolderId: null,
    sourceMode: history ? null : "EXPLICIT",
    sourceAuthority: history ? "PAST_CHAT" : "EXPLICIT", subjectKey: null,
    synthesisDepth: 0, systemFrom: now,
    temperatureClass: null, temperatureScore: 0, validFrom: null, validTo: null
  };
}

function ranked(
  id: string,
  history = false,
  tier: "CORE" | "DYNAMIC" = "DYNAMIC",
  sourceChatId = "chat-source"
):
MemoryRankedCandidate {
  return {
    entryId: tier === "CORE" ? null : `entry-${id}`,
    featureSnapshot: {
      authorityRank: history ? 0 : 3,
      fusionVersion: "rrf",
      laneCount: tier === "CORE" ? 0 : 1,
      temporalFit: 1,
      tier
    },
    finalScore: tier === "CORE" ? 0 : 0.1, itemId: id,
    itemType: history ? "RECALL_CHUNK" : "FACT_VERSION",
    laneRanks: tier === "CORE" ? {} : history ? { HISTORY_RECALL_VECTOR: 1 } : { FACT_VECTOR: 1 },
    metadata: metadata(id, history, sourceChatId), rrfScore: tier === "CORE" ? 0 : 0.1,
    selectionReason: tier === "CORE" ? "core.high" : "semantic_relevance"
  };
}

function expansion(
  id: string,
  history = false,
  text = `memory ${id}`,
  sourceChatId = "chat-source"
): MemoryExpandedCandidate {
  return {
    itemId: id, itemType: history ? "RECALL_CHUNK" : "FACT_VERSION",
    occurredFrom: history ? now : null, occurredTo: history ? now : null,
    projectionKind: history ? "RECALL_CHUNK_SAFE_PROJECTED_TEXT" : "FACT_DISPLAY_TEXT",
    safeText: text, sourceChatId: history ? sourceChatId : null, supportingItemId: null
  };
}

function core(id: string, text?: string): MemoryCoreCandidate {
  return { candidate: ranked(id, false, "CORE"), expansion: expansion(id, false, text) };
}

describe("Personal Memory context pack", () => {
  it("packs bounded response preferences before relevant facts/history", () => {
    const dynamic = [ranked("fact"), ranked("history", true)];
    const pack = packMemoryPersonalContext({
      core: [core("core", "User prefers concise answers")],
      expanded: [expansion("fact"), expansion("history", true)],
      plan,
      ranked: dynamic
    });
    expect(pack.items.map(({ tier }) => tier)).toEqual(["CORE", "DYNAMIC", "DYNAMIC"]);
    expect(pack.text).toContain("Response preferences");
    expect(pack.text).toContain("Relevant prior conversations");
    expect(pack.text).toContain("answer that fact directly");
    expect(pack.packerVersion).toBe("memory-context-packer-v10");
  });

  it("labels depth-one synthesis in a separate inferred-pattern section", () => {
    const pattern = ranked("pattern");
    const patternPlan = planMemoryRetrieval({
      currentUserText: "what pattern do I follow",
      includePatterns: true,
      now
    });
    const pack = packMemoryPersonalContext({
      expanded: [expansion("pattern", false, "User tends to follow a repeatable workflow")],
      plan: patternPlan,
      ranked: [{
        ...pattern,
        metadata: {
          ...pattern.metadata,
          directness: "INFERRED",
          modality: "PATTERN",
          sourceAuthority: "SYNTHESIS",
          sourceMode: "AUTOMATIC",
          synthesisDepth: 1
        }
      }]
    });

    expect(pack.items).toMatchObject([{ itemId: "pattern", section: "PATTERN" }]);
    expect(pack.text).toContain("Inferred patterns:");
  });

  it("accepts a reranked response preference while preserving its Core contract", () => {
    const rerankedCore = core("core", "User prefers concise answers");
    const pack = packMemoryPersonalContext({
      core: [{
        ...rerankedCore,
        candidate: {
          ...rerankedCore.candidate,
          finalScore: 0.9,
          selectionReason: "core.high+direct_relevance"
        }
      }],
      expanded: [],
      plan,
      ranked: []
    });
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]).toMatchObject({ section: "CORE", tier: "CORE" });
  });

  it("packs legacy sensitive Core preferences like normal while excluding secrets", () => {
    const legacySensitive = core("legacy-sensitive", "User prefers short answers");
    const secret = core("secret", "User secret");
    const pack = packMemoryPersonalContext({
      core: [{
        ...legacySensitive,
        candidate: {
          ...legacySensitive.candidate,
          metadata: { ...legacySensitive.candidate.metadata, sensitivityClass: "SENSITIVE" }
        }
      }, {
        ...secret,
        candidate: {
          ...secret.candidate,
          metadata: { ...secret.candidate.metadata, sensitivityClass: "SECRET" }
        }
      }],
      expanded: [],
      plan,
      ranked: []
    });
    expect(pack.items).toMatchObject([{ itemId: "legacy-sensitive", section: "CORE" }]);
    expect(pack.omissionCounts.core_contract_invalid).toBe(1);
  });

  it("rejects arbitrary facts and Core without explicit response-preference admission", () => {
    const eligible = core("eligible", "User prefers concise answers");
    const arbitrary = core("arbitrary", "User works at Example Corp");
    const wrongCategory = {
      ...arbitrary,
      candidate: {
        ...arbitrary.candidate,
        metadata: { ...arbitrary.candidate.metadata, category: "identity" }
      }
    };
    const notAdmittedPlan = planMemoryRetrieval({ currentUserText: "query", now });
    const notAdmitted = packMemoryPersonalContext({
      core: [eligible],
      expanded: [],
      plan: notAdmittedPlan,
      ranked: []
    });
    const arbitraryFact = packMemoryPersonalContext({
      core: [wrongCategory],
      expanded: [],
      plan,
      ranked: []
    });
    expect(notAdmitted.items).toEqual([]);
    expect(notAdmitted.omissionCounts.core_contract_invalid).toBe(1);
    expect(arbitraryFact.items).toEqual([]);
    expect(arbitraryFact.omissionCounts.core_contract_invalid).toBe(1);
  });

  it("deduplicates only by identity/logical key, never fuzzy text", () => {
    const sameWords = "prefers concise answers";
    const pack = packMemoryPersonalContext({
      core: [core("core", sameWords)],
      expanded: [expansion("other", false, sameWords)],
      plan,
      ranked: [ranked("other")]
    });
    expect(pack.items).toHaveLength(2);
  });

  it("keeps Core within its independent bounded budget", () => {
    const pack = packMemoryPersonalContext({
      core: Array.from({ length: 20 }, (_, index) =>
        core(`core-${index}`, "x ".repeat(600))),
      expanded: [],
      plan,
      ranked: []
    });
    expect(pack.coreTokens).toBeLessThanOrEqual(128);
    expect(pack.items.length).toBeLessThan(20);
  });

  it("never exceeds the frozen preparing-attempt item bound", () => {
    const dynamic = Array.from({ length: 12 }, (_, index) => ranked(`fact-${index}`));
    const pack = packMemoryPersonalContext({
      core: Array.from({ length: 12 }, (_, index) => core(`core-${index}`, `c${index}`)),
      expanded: dynamic.map((candidate) => expansion(candidate.itemId, false, "d")),
      plan,
      ranked: dynamic
    });
    expect(pack.items).toHaveLength(10);
    expect(pack.items.filter(({ tier }) => tier === "CORE")).toHaveLength(4);
    expect(pack.items.filter(({ section }) => section === "FACT")).toHaveLength(6);
    expect(pack.omissionCounts.core_item_limit).toBe(8);
    expect(pack.omissionCounts.fact_limit).toBe(6);
  });

  it("packs at most twelve bounded profile facts in deterministic input order", () => {
    const dynamic = Array.from({ length: 15 }, (_, index) => ranked(`profile-${index}`));
    const pack = packMemoryPersonalContext({
      expanded: dynamic.map((candidate) => expansion(candidate.itemId, false, "profile fact")),
      plan: profilePlan,
      ranked: dynamic
    });

    expect(pack.items).toHaveLength(12);
    expect(pack.items.map(({ itemId }) => itemId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `profile-${index}`)
    );
    expect(pack.items.every(({ section }) => section === "FACT")).toBe(true);
    expect(pack.omissionCounts.profile_fact_limit).toBe(3);
    expect(pack.text).toContain("bounded profile inventory");
  });

  it("excludes history from a profile pack even when a caller supplies it", () => {
    const dynamic = [ranked("fact"), ranked("contradictory-history", true)];
    const pack = packMemoryPersonalContext({
      expanded: [expansion("fact"), expansion("contradictory-history", true)],
      plan: profilePlan,
      ranked: dynamic
    });

    expect(pack.items).toMatchObject([{ itemId: "fact", section: "FACT" }]);
    expect(pack.omissionCounts.profile_history_excluded).toBe(1);
    expect(pack.text).not.toContain("contradictory-history");
  });

  it("leaves targeted pack limits and preamble unchanged", () => {
    const targeted = planMemoryRetrieval({ currentUserText: "specific preference", now });
    const dynamic = Array.from({ length: 8 }, (_, index) => ranked(`targeted-${index}`));
    const pack = packMemoryPersonalContext({
      expanded: dynamic.map((candidate) => expansion(candidate.itemId)),
      plan: targeted,
      ranked: dynamic
    });

    expect(pack.items).toHaveLength(6);
    expect(pack.omissionCounts.fact_limit).toBe(2);
    expect(pack.text).toContain(
      "Prefer the current user message and current active chat context on conflict."
    );
    expect(pack.text).not.toContain("bounded profile inventory");
  });

  it("packs distinct aggregation sources before repeats without a per-chat quota", () => {
    const distinct = Array.from({ length: 10 }, (_, index) => ({
      candidate: ranked(`event-${index}`, true, "DYNAMIC", `chat-${index}`),
      expansion: expansion(
        `event-${index}`,
        true,
        `User: completed rehearsal ${index + 1} and recorded its outcome.`,
        `chat-${index}`
      )
    }));
    const repeats = Array.from({ length: 12 }, (_, index) => ({
      candidate: {
        ...ranked(`event-repeat-${index}`, true, "DYNAMIC", "chat-0"),
        finalScore: 0.99 - index / 100
      },
      expansion: expansion(
        `event-repeat-${index}`,
        true,
        `User: additional relevant detail ${index + 1} from the first conversation.`,
        "chat-0"
      )
    }));
    const pack = packMemoryPersonalContext({
      expanded: [
        ...repeats.map(({ expansion }) => expansion),
        ...distinct.map(({ expansion }) => expansion)
      ],
      plan: aggregationPlan,
      ranked: [
        ...repeats.map(({ candidate }) => candidate),
        ...distinct.map(({ candidate }) => candidate)
      ]
    });

    expect(pack.items).toHaveLength(20);
    expect(new Set(pack.items.map(({ sourceChatId }) => sourceChatId)).size).toBe(10);
    expect(pack.items.filter(({ sourceChatId }) => sourceChatId === "chat-0")).toHaveLength(11);
    expect(pack.items.slice(0, 10).map(({ sourceChatId }) => sourceChatId))
      .toEqual(Array.from({ length: 10 }, (_, index) => `chat-${index}`));
    expect(pack.approxTokens).toBeLessThanOrEqual(10_000);
    expect(pack.hardCapTokens).toBe(10_000);
    expect(pack.text).toContain("Combine every relevant listed event");
    expect(pack.text).toContain(
      "Keep set members, temporal boundaries, and supporting facts distinct"
    );
    expect(pack.text).not.toContain("Do not count the boundary event itself");
  });

  it("makes the ten-source aggregation ceiling reachable for full history chunks", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      candidate: ranked(`long-event-${index}`, true, "DYNAMIC", `long-chat-${index}`),
      expansion: expansion(
        `long-event-${index}`,
        true,
        `Event ${index + 1}: ${"bounded detail ".repeat(175)}`,
        `long-chat-${index}`
      )
    }));
    const pack = packMemoryPersonalContext({
      expanded: items.map(({ expansion }) => expansion),
      plan: aggregationPlan,
      ranked: items.map(({ candidate }) => candidate)
    });

    expect(pack.items).toHaveLength(10);
    expect(pack.omissionCounts.history_token_budget).toBeUndefined();
    expect(pack.targetTokens).toBe(10_000);
    expect(pack.hardCapTokens).toBe(10_000);
  });

  it("separates current and dated superseded facts in a historical pack", () => {
    const current = ranked("current");
    const previousBase = ranked("previous");
    const previous: MemoryRankedCandidate = {
      ...previousBase,
      metadata: {
        ...previousBase.metadata,
        current: false,
        historical: true,
        lifecycleState: "SUPERSEDED",
        systemFrom: new Date("2025-07-01T00:00:00.000Z"),
        validFrom: new Date("2025-07-01T00:00:00.000Z"),
        validTo: new Date("2025-08-01T00:00:00.000Z")
      }
    };
    const pack = packMemoryPersonalContext({
      expanded: [
        expansion("current", false, "The user uses Neovim."),
        expansion("previous", false, "The user used Vim.")
      ],
      plan: historicalPlan,
      ranked: [previous, current]
    });

    expect(pack.items).toMatchObject([
      { itemId: "previous", section: "HISTORICAL_FACT", temporalReason: "historical" },
      { itemId: "current", section: "FACT", temporalReason: "historical" }
    ]);
    expect(pack.text).toContain("Current user facts:");
    expect(pack.text).toContain("Historical user memory:");
    expect(pack.text).toContain("[2025-07-01] The user used Vim.");
  });
});
