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
const plan = planMemoryRetrieval({ currentUserText: "query", now });

function metadata(id: string, history = false): MemoryCandidateMetadata {
  return {
    canonicalKey: null, category: "memory", confidence: 0, conflict: false,
    coreEligible: !history, coreSalience: history ? "NONE" : "HIGH", current: true,
    dedupeKey: id, directness: history ? null : "DIRECT", factId: history ? null : id,
    historical: false, historySafetyClass: history ? "NORMAL" : null, importance: 0,
    languageCode: "und", modality: history ? null : "PREFERENCE", occurredFrom: null,
    occurredTo: null, pinned: false, scopeAffinity: 0, scopeType: history ? null : "GLOBAL_USER",
    sensitivityClass: history ? null : "NORMAL", sourceAssistantId: null,
    sourceChatId: history ? "chat-source" : null, sourceFolderId: null,
    sourceMode: history ? null : "AUTOMATIC", systemFrom: now,
    temperatureClass: null, validFrom: null, validTo: null
  };
}

function ranked(id: string, history = false, tier: "CORE" | "DYNAMIC" = "DYNAMIC"):
MemoryRankedCandidate {
  return {
    entryId: tier === "CORE" ? null : `entry-${id}`,
    featureSnapshot: { fusionVersion: "rrf", laneCount: tier === "CORE" ? 0 : 1, tier },
    finalScore: tier === "CORE" ? 0 : 0.1, itemId: id,
    itemType: history ? "RECALL_CHUNK" : "FACT_VERSION",
    laneRanks: tier === "CORE" ? {} : history ? { HISTORY_RECALL_VECTOR: 1 } : { FACT_VECTOR: 1 },
    metadata: metadata(id, history), rrfScore: tier === "CORE" ? 0 : 0.1,
    selectionReason: tier === "CORE" ? "core.high" : "semantic_relevance"
  };
}

function expansion(id: string, history = false, text = `memory ${id}`): MemoryExpandedCandidate {
  return {
    itemId: id, itemType: history ? "RECALL_CHUNK" : "FACT_VERSION",
    occurredFrom: history ? now : null, occurredTo: history ? now : null,
    projectionKind: history ? "RECALL_CHUNK_SAFE_PROJECTED_TEXT" : "FACT_DISPLAY_TEXT",
    safeText: text, sourceChatId: history ? "chat-source" : null, supportingItemId: null
  };
}

function core(id: string, text?: string): MemoryCoreCandidate {
  return { candidate: ranked(id, false, "CORE"), expansion: expansion(id, false, text) };
}

describe("single-tiered Memory context pack", () => {
  it("packs Core first and relevant dynamic facts/history afterwards", () => {
    const dynamic = [ranked("fact"), ranked("history", true)];
    const pack = packMemoryPersonalContext({
      core: [core("core", "User prefers concise answers")],
      expanded: [expansion("fact"), expansion("history", true)],
      plan,
      ranked: dynamic
    });
    expect(pack.items.map(({ tier }) => tier)).toEqual(["CORE", "DYNAMIC", "DYNAMIC"]);
    expect(pack.text).toContain("Core memory");
    expect(pack.text).toContain("Relevant prior conversations");
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
    expect(pack.coreTokens).toBeLessThanOrEqual(512);
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
    expect(pack.items).toHaveLength(12);
    expect(pack.omissionCounts.item_limit).toBe(12);
  });
});
