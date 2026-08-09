import { describe, expect, it } from "vitest";
import {
  buildMemoryAdjudicationManifest,
  hashMemoryAdjudicationManifest
} from "../../fixtures/memory-evaluation/adjudication";
import { buildNoMemoryBaselineManifest } from "../../fixtures/memory-evaluation/manifestBuilders";
import { loadFrozenMemoryCorpus, readMemoryCorpusJson } from "./testSupport";

const corpus = loadFrozenMemoryCorpus();
const adjudication = buildMemoryAdjudicationManifest(corpus.fixtures);
const adjudicationHash = hashMemoryAdjudicationManifest(adjudication);

describe("native Memory adjudication and no-memory baseline", () => {
  it("covers every fixture with two independent reviews and resolved disagreements", () => {
    const fixtureCoverage = new Map<string, number>();
    let disagreementCount = 0;
    let thirdAdjudicatorResolutionCount = 0;

    for (const record of adjudication.records) {
      expect([1, 20]).toContain(record.fixtureIds.length);
      expect(record.primaryReviews[0].adjudicatorId).not.toBe(
        record.primaryReviews[1].adjudicatorId
      );
      for (const fixtureId of record.fixtureIds) {
        fixtureCoverage.set(fixtureId, (fixtureCoverage.get(fixtureId) ?? 0) + 1);
      }
      const disagreed = record.primaryReviews[0].decision !== record.primaryReviews[1].decision;
      if (disagreed) {
        disagreementCount += 1;
        expect(record.ambiguityCode).toBe("LABEL_BOUNDARY_REVIEWED");
        expect(record.resolution).not.toBeNull();
        expect(record.resolution?.resolverId).not.toBe(
          record.primaryReviews[0].adjudicatorId
        );
        expect(record.resolution?.resolverId).not.toBe(
          record.primaryReviews[1].adjudicatorId
        );
        if (record.resolution?.type === "THIRD_ADJUDICATOR") {
          thirdAdjudicatorResolutionCount += 1;
        }
      } else {
        expect(record.ambiguityCode).toBeNull();
        expect(record.resolution).toBeNull();
      }
    }

    expect(adjudication.records).toHaveLength(128);
    expect(adjudication.records.filter(({ fixtureIds }) => fixtureIds.length === 20))
      .toHaveLength(80);
    expect(adjudication.records.filter(({ fixtureIds }) => fixtureIds.length === 1))
      .toHaveLength(48);
    expect(disagreementCount).toBe(32);
    expect(thirdAdjudicatorResolutionCount).toBe(32);
    expect(fixtureCoverage.size).toBe(corpus.fixtures.length);
    expect([...fixtureCoverage.values()].every((count) => count === 1)).toBe(true);
  });

  it("matches the frozen adjudication summary", () => {
    expect({
      contentHash: adjudicationHash,
      manifestVersion: adjudication.manifestVersion,
      recordCount: adjudication.records.length,
      resolutionCount: adjudication.records.filter(({ resolution }) => resolution !== null).length,
      rubricVersion: adjudication.rubricVersion
    }).toEqual(readMemoryCorpusJson("manifests/adjudication-v1.json"));
  });

  it("reproduces sanitized aggregate-only no-memory evidence", () => {
    const build = () => buildNoMemoryBaselineManifest({
      adjudicationManifestHash: adjudicationHash,
      corpusManifest: corpus.manifest,
      fixtures: corpus.fixtures
    });
    const first = build();
    expect(build()).toEqual(first);
    expect(first).toEqual(readMemoryCorpusJson("manifests/no-memory-baseline-v1.json"));

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("fixture-");
    expect(serialized).not.toContain("message-");
    expect(serialized).not.toContain("SYNTHETIC_SECRET");
    expect(first.randomSeed).toBe(4242);
    expect(first.sanitizedAggregatesOnly).toBe(true);
  });
});
