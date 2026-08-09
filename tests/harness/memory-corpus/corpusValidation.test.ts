import { describe, expect, it } from "vitest";
import { buildMemoryCorpusManifest } from "../../fixtures/memory-evaluation/manifestBuilders";
import {
  MEMORY_CRITICAL_COHORTS,
  MEMORY_GENERAL_LIFECYCLE_COHORTS,
  type MemoryCorpusFixture
} from "../../fixtures/memory-evaluation/shared/corpusTypes";
import { validateFrozenMemoryCorpus } from "../../fixtures/memory-evaluation/validation";
import { loadFrozenMemoryCorpus } from "./testSupport";

const corpus = loadFrozenMemoryCorpus();

describe("native Memory frozen corpus", () => {
  it("validates exact IDs, sources, ownership, branches, groups, and the frozen hash", () => {
    expect(validateFrozenMemoryCorpus({
      fixtures: corpus.fixtures,
      frozenManifest: corpus.manifest
    })).toEqual({
      actionCount: 700,
      fixtureCount: 1648,
      groupCounts: { HOLDOUT: 64, TUNING: 64 },
      messageCount: 3624,
      queryCount: 1648
    });
    expect(buildMemoryCorpusManifest(corpus.fixtures)).toEqual(corpus.manifest);
  });

  it("meets every RU and EN holdout minimum independently", () => {
    const holdout = corpus.manifest.splits.HOLDOUT;
    for (const language of ["RU", "EN"] as const) {
      expect(holdout.languages[language]).toMatchObject({
        adversarialCases: 140,
        factScenarios: 412,
        fixtures: 412,
        judgedRetrievalQueries: 412
      });
      expect(Object.keys(holdout.criticalCohorts[language])).toEqual(
        MEMORY_CRITICAL_COHORTS
      );
      expect(Object.values(holdout.criticalCohorts[language])).toEqual(
        MEMORY_CRITICAL_COHORTS.map(() => 20)
      );
    }
  });

  it("covers every general lifecycle contract in both languages and splits", () => {
    for (const split of ["TUNING", "HOLDOUT"] as const) {
      for (const language of ["RU", "EN"] as const) {
        for (const cohort of MEMORY_GENERAL_LIFECYCLE_COHORTS) {
          const fixtures = corpus.fixtures.filter((fixture) =>
            fixture.split === split &&
            fixture.language === language &&
            fixture.cohort === cohort
          );
          expect(fixtures).toHaveLength(1);
          expect(fixtures[0].actions.length).toBeGreaterThan(0);
          expect(fixtures[0].expectedLifecycle.events.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
    for (const cohort of [
      "temporary-zero-memory",
      "account-deletion-purge",
      "public-share-stripping"
    ] as const) {
      for (const fixture of corpus.fixtures.filter((value) => value.cohort === cohort)) {
        expect(fixture.expectedEgress).toEqual({
          allowedDestinations: ["LOCAL_ONLY"],
          remoteCallsAllowed: false,
          requiresAcceptedFingerprint: false
        });
      }
    }
  });

  it("uses identical fact text for two owners in the cross-user isolation cohort", () => {
    const fixtures = corpus.fixtures.filter(({ cohort }) => cohort === "cross-user-isolation");
    expect(fixtures).toHaveLength(80);
    for (const fixture of fixtures) {
      const ownerMessages = fixture.chats.map((chat) =>
        chat.messages.find(({ role }) => role === "user")
      );
      expect(ownerMessages).toHaveLength(2);
      expect(ownerMessages[0]?.text).toBe(ownerMessages[1]?.text);
      expect(ownerMessages[0]?.ownerUserId).not.toBe(ownerMessages[1]?.ownerUserId);
      expect(fixture.queries[0].forbiddenMessageIds).toContain(ownerMessages[1]?.id);
    }
  });

  it("rejects an unversioned content change against the frozen manifest", () => {
    const [first, ...rest] = corpus.fixtures;
    const [firstChat, ...otherChats] = first.chats;
    const [firstMessage, ...otherMessages] = firstChat.messages;
    const changed: MemoryCorpusFixture = {
      ...first,
      chats: [{
        ...firstChat,
        messages: [{ ...firstMessage, text: `${firstMessage.text} changed` }, ...otherMessages]
      }, ...otherChats]
    };

    expect(() => validateFrozenMemoryCorpus({
      fixtures: [changed, ...rest],
      frozenManifest: corpus.manifest
    })).toThrow("memory_corpus_frozen_manifest_mismatch");
  });

  it("rejects an inexact source message reference before scoring", () => {
    const [first, ...rest] = corpus.fixtures;
    const changed: MemoryCorpusFixture = {
      ...first,
      expectedFacts: first.expectedFacts.map((fact, index) => index === 0
        ? { ...fact, sourceMessageIds: ["message-does-not-exist"] }
        : fact)
    };

    expect(() => validateFrozenMemoryCorpus({
      fixtures: [changed, ...rest],
      frozenManifest: corpus.manifest
    })).toThrow("memory_corpus_unknown_source_message");
  });

  it("contains synthetic data only and no credential-shaped values", () => {
    const serialized = JSON.stringify(corpus.fixtures);
    expect(corpus.fixtures.every(({ dataClass }) => dataClass === "SYNTHETIC")).toBe(true);
    expect(serialized).not.toMatch(/-----BEGIN [A-Z ]+PRIVATE KEY-----/u);
    expect(serialized).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/u);
    expect(serialized).not.toMatch(/\b(?:ghp_|sk-)[A-Za-z0-9_-]{20,}\b/u);
    const syntheticSecrets = new Set(serialized.match(/[A-Z]+_SECRET_[A-Z]+_\d+/gu));
    expect(syntheticSecrets.size).toBe(80);
    expect([...syntheticSecrets].every((value) =>
      /^SYNTHETIC_SECRET_(?:RU|EN)_\d{4}$/u.test(value)
    )).toBe(true);
  });
});
