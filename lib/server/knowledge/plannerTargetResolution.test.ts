import { describe, expect, it } from "vitest";
import {
  decodeKnowledgePlannerTargetResolution,
  knowledgePlannerMetadataMentions,
  resolveKnowledgePlannerTargets,
  type KnowledgePlannerSourceIdentity
} from "./plannerTargetResolution";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const decemberId = "33333333-3333-4333-8333-333333333333";

const sources: readonly KnowledgePlannerSourceIdentity[] = [{
  fileName: "Alpha Policy.pdf",
  sourceAlias: "S1",
  sourceId: alphaId,
  sourceName: "Alpha Policy",
  versionNumber: 2
}, {
  fileName: "Beta-and-Gamma.pdf",
  sourceAlias: "S2",
  sourceId: betaId,
  sourceName: "Beta and Gamma",
  versionNumber: 4
}, {
  fileName: "Анализы 2025-12-08.pdf",
  sourceAlias: "S3",
  sourceId: decemberId,
  sourceName: "Холестерин — декабрь",
  versionNumber: 3
}];

describe("Knowledge planner target resolution", () => {
  it.each([
    ["S1", "alias", alphaId],
    ["Alpha Policy.pdf", "file_name", alphaId],
    ["alpha policy", "source_name", alphaId],
    ["Beta and Gamma.pdf", "normalized_title", betaId],
    ["Alpha Policy version 2", "source_name", alphaId],
    ["Анализы 2025-12-08", "normalized_title", decemberId],
    ["Холестерин — декабрь версия 3", "source_name", decemberId]
  ] as const)("resolves admitted metadata %s", (targetName, matchKind, sourceId) => {
    const resolved = resolveKnowledgePlannerTargets({ sources, targetNames: [targetName] });

    expect(resolved).toEqual({
      outcome: "resolved",
      targets: [{
        candidateSourceIds: [sourceId],
        matchKind,
        outcome: "resolved",
        targetName
      }],
      targetSourceIds: [sourceId]
    });
    expect(decodeKnowledgePlannerTargetResolution(resolved)).toEqual(resolved);
  });

  it("returns resolved_many only for an explicit set of uniquely resolved targets", () => {
    const resolved = resolveKnowledgePlannerTargets({
      sources,
      targetNames: ["Alpha Policy.pdf", "S2"]
    });

    expect(resolved).toMatchObject({
      outcome: "resolved_many",
      targetSourceIds: [alphaId, betaId]
    });
  });

  it("keeps duplicate exact metadata ambiguous", () => {
    const resolved = resolveKnowledgePlannerTargets({
      sources: [...sources, {
        fileName: "Alpha Policy copy.pdf",
        sourceAlias: "S4",
        sourceId: "44444444-4444-4444-8444-444444444444",
        sourceName: "Alpha Policy",
        versionNumber: 2
      }],
      targetNames: ["Alpha Policy"]
    });

    expect(resolved).toMatchObject({
      outcome: "ambiguous",
      targetSourceIds: [],
      targets: [{
        candidateSourceIds: [alphaId, "44444444-4444-4444-8444-444444444444"],
        matchKind: "source_name",
        outcome: "ambiguous"
      }]
    });
  });

  it("never promotes a typo-only candidate to an executable resolution", () => {
    const resolved = resolveKnowledgePlannerTargets({
      sources,
      targetNames: ["Alhpa Policy"]
    });

    expect(resolved).toEqual({
      outcome: "ambiguous",
      targets: [{
        candidateSourceIds: [alphaId],
        matchKind: "fuzzy",
        outcome: "ambiguous",
        targetName: "Alhpa Policy"
      }],
      targetSourceIds: []
    });
  });

  it("returns not_found and ignores body-like properties outside the identity contract", () => {
    const sourceWithBody = {
      ...sources[0],
      body: "Secret Body Target"
    } as KnowledgePlannerSourceIdentity;
    const resolved = resolveKnowledgePlannerTargets({
      sources: [sourceWithBody],
      targetNames: ["Secret Body Target"]
    });

    expect(resolved).toEqual({
      outcome: "not_found",
      targets: [{
        candidateSourceIds: [],
        matchKind: "none",
        outcome: "not_found",
        targetName: "Secret Body Target"
      }],
      targetSourceIds: []
    });
  });

  it.each([
    "Alpha Policy version 3",
    "Анализы 2025-12-09"
  ])("does not discard a mismatching version/date qualifier: %s", (targetName) => {
    expect(resolveKnowledgePlannerTargets({ sources, targetNames: [targetName] })).toMatchObject({
      outcome: "not_found",
      targetSourceIds: []
    });
  });

  it("extracts whole admitted filenames without destructively splitting conjunctions", () => {
    expect(knowledgePlannerMetadataMentions({
      query: "Compare Alpha Policy.pdf and Beta-and-Gamma.pdf by owner",
      sources
    })).toEqual(["Alpha Policy.pdf", "Beta-and-Gamma.pdf"]);
    expect(knowledgePlannerMetadataMentions({
      query: "Sort the policies alphabetically",
      sources
    })).toEqual([]);
  });

  it("rejects unknown persisted resolution fields and inconsistent confidence", () => {
    const resolved = resolveKnowledgePlannerTargets({ sources, targetNames: ["S1"] });
    expect(decodeKnowledgePlannerTargetResolution({ ...resolved, debug: true })).toBeUndefined();
    expect(decodeKnowledgePlannerTargetResolution({
      ...resolved,
      targets: [{
        candidateSourceIds: [alphaId],
        matchKind: "fuzzy",
        outcome: "resolved",
        targetName: "Alhpa Policy"
      }]
    })).toBeUndefined();
  });
});
