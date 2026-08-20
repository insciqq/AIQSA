import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "./evidencePackage";
import {
  KNOWLEDGE_SEMANTIC_NEIGHBORHOOD_VERSION,
  decodeKnowledgeSemanticGroundingPrediction,
  knowledgeSemanticClaimValidationText,
  segmentKnowledgeSemanticClaims
} from "./semanticGrounding";

function item(
  ordinal: number,
  excerpt: string,
  overrides: Partial<KnowledgeEvidencePackageItem> = {}
): KnowledgeEvidencePackageItem {
  return {
    baseName: "Synthetic semantic corpus",
    contentHash: String(ordinal).repeat(64).slice(0, 64),
    contextBoundaries: {
      expanded: false,
      excerptBytes: Buffer.byteLength(excerpt),
      sourceTextBytes: Buffer.byteLength(excerpt)
    },
    documentId: `semantic-document-${ordinal}`,
    documentVersionId: `semantic-document-version-${ordinal}`,
    excerpt,
    fileName: `semantic-${ordinal}.md`,
    handle: `K${ordinal}`,
    headingPath: ["Synthetic section"],
    id: `semantic-evidence-${ordinal}`,
    knowledgeBaseId: "semantic-base",
    locator: { page: ordinal },
    ordinal,
    passageId: `semantic-passage-${ordinal}`,
    provenance: [],
    sectionId: `semantic-section-${ordinal}`,
    sourceArtifactId: `semantic-artifact-${ordinal}`,
    sourceId: `semantic-source-${ordinal}`,
    sourceName: `Semantic source ${ordinal}`,
    sourceVersionId: `semantic-source-version-${ordinal}`,
    sourceVersionNumber: ordinal,
    state: "available",
    textTruncated: false,
    ...overrides
  };
}

function evidence(items: readonly KnowledgeEvidencePackageItem[]): KnowledgeEvidencePackage {
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount: null,
      mode: "partial",
      namedTargets: [],
      verified: false
    },
    degradedFlags: [],
    items,
    originalIntent: { intent: "fact_lookup", query: "What does the policy say?" },
    readiness: { excludedResources: 0, readyBases: 1, readySources: items.length },
    runId: "semantic-run",
    scopeSnapshot: { mode: "explicit" },
    sessionId: "semantic-session",
    strategy: "focused",
    version: 2
  };
}

describe("Knowledge semantic grounding shadow contract", () => {
  it("segments prose and lists while keeping each neighborhood citation-local", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: [
        "# Access policy",
        "Staff may work remotely on Fridays [K1].",
        "- Contractors need manager approval [K2]."
      ].join("\n"),
      evidence: evidence([
        item(1, "Employees may work from home each Friday."),
        item(2, "Contractors require manager approval."),
        item(3, "An unrelated source prohibits external access.")
      ])
    });

    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      citationHandles: ["K1"],
      context: ["Access policy"],
      neighborhoodRule: "inline",
      ordinal: 1,
      sourceShape: "prose",
      type: "source_fact",
      unknownCitationHandles: []
    });
    expect(claims[0]?.evidenceItems.map((entry) => entry.handle)).toEqual(["K1"]);
    expect(claims[1]).toMatchObject({
      citationHandles: ["K2"],
      context: ["Access policy"],
      ordinal: 2,
      sourceShape: "list"
    });
    expect(claims.every((claim) =>
      claim.neighborhoodVersion === KNOWLEDGE_SEMANTIC_NEIGHBORHOOD_VERSION)).toBe(true);
    expect(claims.flatMap((claim) => claim.evidenceItems.map((entry) => entry.handle)))
      .not.toContain("K3");
    expect(knowledgeSemanticClaimValidationText(claims[0]!))
      .toBe("Access policy — Staff may work remotely on Fridays [K1].");
  });

  it("splits independently cited semicolon clauses and retains bold heading context", () => {
    const answer = [
      "**Regional status**",
      "Atlas is active [K1]; Boreal is paused [K2]."
    ].join("\n");
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([
        item(1, "Atlas is active."),
        item(2, "Boreal is paused.")
      ])
    });

    expect(claims).toHaveLength(2);
    expect(claims.map(({ citationHandles, context, text }) => ({ citationHandles, context, text })))
      .toEqual([
        {
          citationHandles: ["K1"],
          context: ["Regional status"],
          text: "Atlas is active [K1];"
        },
        {
          citationHandles: ["K2"],
          context: ["Regional status"],
          text: "Boreal is paused [K2]."
        }
      ]);
    expect(claims[0]?.answerStart).toBe(answer.indexOf("Atlas"));
    expect(claims[1]?.answerStart).toBe(answer.indexOf("Boreal"));
  });

  it.each([
    {
      answer: "Atlas is active; Boreal remains paused [K1].",
      texts: ["Atlas is active;", "Boreal remains paused [K1]."]
    },
    {
      answer: "Север активен; Юг остаётся приостановлен [K1].",
      texts: ["Север активен;", "Юг остаётся приостановлен [K1]."]
    }
  ])("splits citation-independent semicolon facts and shares one terminal syntactic citation: $answer",
    ({ answer, texts }) => {
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([item(1, "Atlas is active and Boreal remains paused.")])
    });

    expect(claims.map((claim) => ({
      answerEnd: claim.answerEnd,
      answerStart: claim.answerStart,
      citationHandles: claim.citationHandles,
      neighborhoodRule: claim.neighborhoodRule,
      rangeText: answer.slice(claim.answerStart, claim.answerEnd),
      text: claim.text,
      type: claim.type
    }))).toEqual(texts.map((text) => ({
      answerEnd: answer.indexOf(text) + text.length,
      answerStart: answer.indexOf(text),
      citationHandles: ["K1"],
      neighborhoodRule: "inline",
      rangeText: text,
      text,
      type: "source_fact"
    })));
  });

  it.each([
    {
      answer: "Atlas is active, and Boreal remains paused [K1].",
      texts: ["Atlas is active,", "Boreal remains paused [K1]."]
    },
    {
      answer: "Север активен, и Юг остаётся приостановлен [K1].",
      texts: ["Север активен,", "Юг остаётся приостановлен [K1]."]
    }
  ])("splits coordinated independent facts with a shared terminal citation: $answer",
    ({ answer, texts }) => {
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([item(1, "Both independently stated facts are supported.")])
    });

    expect(claims.map((claim) => ({
      answerEnd: claim.answerEnd,
      answerStart: claim.answerStart,
      citationHandles: claim.citationHandles,
      rangeText: answer.slice(claim.answerStart, claim.answerEnd),
      text: claim.text,
      type: claim.type
    }))).toEqual(texts.map((text) => ({
      answerEnd: answer.indexOf(text) + text.length,
      answerStart: answer.indexOf(text),
      citationHandles: ["K1"],
      rangeText: text,
      text,
      type: "source_fact"
    })));
  });

  it("does not split a noun enumeration that lacks independent propositions", () => {
    const answer = "Regions include Atlas, Boreal, and Cedar [K1].";
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([item(1, "The regions are Atlas, Boreal, and Cedar.")])
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      answerEnd: answer.length,
      answerStart: 0,
      citationHandles: ["K1"],
      text: answer,
      type: "source_fact"
    });
  });

  it("inherits heading, caption, and nested list context only across tight formatting groups", () => {
    const answer = [
      "# Rollout",
      "Figure 1: Regional status [K1]",
      "Atlas is active.",
      "",
      "**Approvals**",
      "- Regions:",
      "  - Boreal remains paused",
      "  - Cedar remains active",
      "[K2]"
    ].join("\n");
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([
        item(1, "Atlas is active."),
        item(2, "Boreal is paused and Cedar is active.")
      ])
    });

    expect(claims.map((claim) => ({
      answerEnd: claim.answerEnd,
      answerStart: claim.answerStart,
      citationHandles: claim.citationHandles,
      context: claim.context,
      rangeText: answer.slice(claim.answerStart, claim.answerEnd),
      sourceShape: claim.sourceShape,
      text: claim.text
    }))).toEqual([
      {
        answerEnd: answer.indexOf("Atlas is active.") + "Atlas is active.".length,
        answerStart: answer.indexOf("Atlas is active."),
        citationHandles: ["K1"],
        context: ["Rollout", "Figure 1: Regional status"],
        rangeText: "Atlas is active.",
        sourceShape: "prose",
        text: "Atlas is active."
      },
      {
        answerEnd: answer.indexOf("Boreal remains paused") + "Boreal remains paused".length,
        answerStart: answer.indexOf("Boreal remains paused"),
        citationHandles: ["K2"],
        context: ["Rollout", "Approvals", "Regions:"],
        rangeText: "Boreal remains paused",
        sourceShape: "list",
        text: "Boreal remains paused"
      },
      {
        answerEnd: answer.indexOf("Cedar remains active") + "Cedar remains active".length,
        answerStart: answer.indexOf("Cedar remains active"),
        citationHandles: ["K2"],
        context: ["Rollout", "Approvals", "Regions:"],
        rangeText: "Cedar remains active",
        sourceShape: "list",
        text: "Cedar remains active"
      }
    ]);
  });

  it("inherits an explicit nested-list parent citation without widening to siblings", () => {
    const answer = [
      "- Atlas policy [K1]:",
      "  - Remote access is enabled",
      "- Boreal policy:",
      "  - Remote access is disabled"
    ].join("\n");
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([
        item(1, "The Atlas policy enables remote access."),
        item(2, "Boreal evidence is admitted but not cited.")
      ])
    });

    expect(claims.map((claim) => ({
      citationHandles: claim.citationHandles,
      context: claim.context,
      evidenceHandles: claim.evidenceItems.map((entry) => entry.handle),
      text: claim.text
    }))).toEqual([
      {
        citationHandles: ["K1"],
        context: ["Atlas policy:"],
        evidenceHandles: ["K1"],
        text: "Remote access is enabled"
      },
      {
        citationHandles: [],
        context: ["Boreal policy:"],
        evidenceHandles: [],
        text: "Remote access is disabled"
      }
    ]);
  });

  it("segments Markdown table cells with header and row context", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: [
        "| Version | Period | Status |",
        "| --- | --- | --- |",
        "| 2025 | 30 days [K1] | Previous rule [K1] |",
        "| 2026 | 14 days [K2] | Current rule [K2] |"
      ].join("\n"),
      evidence: evidence([
        item(1, "The 2025 policy required 30 days."),
        item(2, "The 2026 policy requires 14 days.")
      ])
    });

    expect(claims).toHaveLength(4);
    expect(claims.map((claim) => claim.citationHandles)).toEqual([
      ["K1"], ["K1"], ["K2"], ["K2"]
    ]);
    expect(claims.every((claim) => claim.sourceShape === "table_cell")).toBe(true);
    expect(claims.every((claim) => claim.type === "versioned_fact")).toBe(true);
    expect(claims[0]).toMatchObject({
      context: ["Version: 2025", "Period"],
      neighborhoodRule: "table_cell",
      text: "30 days [K1]"
    });
    expect(claims[3]).toMatchObject({
      context: ["Version: 2026", "Status"],
      text: "Current rule [K2]"
    });
  });

  it("inherits one explicit row citation without consulting other admitted evidence", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: [
        "| Metric | Value | Citation |",
        "| --- | --- | --- |",
        "| Alpha | 12.4 units | [K1] |"
      ].join("\n"),
      evidence: evidence([
        item(1, "Alpha is 12.4 units."),
        item(2, "Beta is 18.2 units.")
      ])
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      citationHandles: ["K1"],
      context: ["Metric: Alpha", "Value"],
      neighborhoodRule: "table_row_inherited",
      text: "12.4 units"
    });
    expect(claims[0]?.evidenceItems.map((entry) => entry.handle)).toEqual(["K1"]);
  });

  it("keeps multiple table value citations cell-local and refuses subject or neighbor poisoning", () => {
    const answer = [
      "| Region | Current | Target | Status |",
      "| --- | --- | --- | --- |",
      "| North [K3] | 12 ms [K1] | 15 ms [K2] | Stable status |"
    ].join("\n");
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([
        item(1, "North currently measures 12 ms."),
        item(2, "North targets 15 ms."),
        item(3, "A subject-only citation says nothing about the values."),
        item(4, "Uncited poisoning evidence says the status is unstable.")
      ])
    });

    expect(claims.map((claim) => ({
      answerEnd: claim.answerEnd,
      answerStart: claim.answerStart,
      citationHandles: claim.citationHandles,
      context: claim.context,
      evidenceHandles: claim.evidenceItems.map((entry) => entry.handle),
      rangeText: answer.slice(claim.answerStart, claim.answerEnd),
      text: claim.text,
      type: claim.type
    }))).toEqual([
      {
        answerEnd: answer.indexOf("12 ms [K1]") + "12 ms [K1]".length,
        answerStart: answer.indexOf("12 ms [K1]"),
        citationHandles: ["K1"],
        context: ["Region: North", "Current"],
        evidenceHandles: ["K1"],
        rangeText: "12 ms [K1]",
        text: "12 ms [K1]",
        type: "source_fact"
      },
      {
        answerEnd: answer.indexOf("15 ms [K2]") + "15 ms [K2]".length,
        answerStart: answer.indexOf("15 ms [K2]"),
        citationHandles: ["K2"],
        context: ["Region: North", "Target"],
        evidenceHandles: ["K2"],
        rangeText: "15 ms [K2]",
        text: "15 ms [K2]",
        type: "source_fact"
      },
      {
        answerEnd: answer.indexOf("Stable status") + "Stable status".length,
        answerStart: answer.indexOf("Stable status"),
        citationHandles: [],
        context: ["Region: North", "Status"],
        evidenceHandles: [],
        rangeText: "Stable status",
        text: "Stable status",
        type: "source_fact"
      }
    ]);
  });

  it("does not treat a neighboring value citation as a row citation", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: [
        "| Metric | Current | Target |",
        "| --- | --- | --- |",
        "| Alpha | 12 units | 14 units [K2] |"
      ].join("\n"),
      evidence: evidence([
        item(1, "Poisoning evidence for the current value."),
        item(2, "The target is 14 units.")
      ])
    });

    expect(claims.map((claim) => ({
      citationHandles: claim.citationHandles,
      evidenceHandles: claim.evidenceItems.map((entry) => entry.handle),
      neighborhoodRule: claim.neighborhoodRule,
      text: claim.text
    }))).toEqual([
      {
        citationHandles: [],
        evidenceHandles: [],
        neighborhoodRule: "none",
        text: "12 units"
      },
      {
        citationHandles: ["K2"],
        evidenceHandles: ["K2"],
        neighborhoodRule: "table_cell",
        text: "14 units [K2]"
      }
    ]);
  });

  it("classifies coverage, arithmetic, summaries, general knowledge, inference, and comparisons", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: [
        "All selected sources report the same status [K1][K2].",
        "The average is 12.5 units [K1].",
        "I couldn't find the launch date in the selected sources.",
        "General knowledge: a leap year normally has 366 days.",
        "Inference: therefore the rollout should be delayed.",
        "Atlas differs from Boreal [K1][K2].",
        "Figure 1: Atlas latency is 20 ms [K1]."
      ].join("\n"),
      evidence: evidence([
        item(1, "Atlas status and measurements."),
        item(2, "Boreal status and measurements.")
      ])
    });

    expect(claims.map(({ type }) => type)).toEqual([
      "coverage_claim",
      "derived_arithmetic",
      "source_summary",
      "general_knowledge",
      "explicit_inference",
      "comparison",
      "source_fact"
    ]);
    expect(claims[0]?.citationHandles).toEqual(["K1", "K2"]);
    expect(claims[2]?.citationHandles).toEqual([]);
  });

  it("keeps EN/RU conflict comparisons atomic and leaves no-answer/general knowledge uncited", () => {
    const answer = [
      "The sources conflict: access is permitted [K1], while it is prohibited [K2].",
      "Источники расходятся: экспорт включён [K1], тогда как экспорт отключён [K2].",
      "I couldn't find the launch date in the selected sources.",
      "Общие сведения: вода замерзает при нормальном давлении."
    ].join("\n");
    const claims = segmentKnowledgeSemanticClaims({
      answer,
      evidence: evidence([
        item(1, "Access is permitted; export is enabled."),
        item(2, "Access is prohibited; export is disabled."),
        item(3, "Uncited poisoning evidence asserts a launch date.")
      ])
    });
    const texts = answer.split("\n");

    expect(claims.map((claim) => ({
      answerEnd: claim.answerEnd,
      answerStart: claim.answerStart,
      citationHandles: claim.citationHandles,
      evidenceHandles: claim.evidenceItems.map((entry) => entry.handle),
      rangeText: answer.slice(claim.answerStart, claim.answerEnd),
      text: claim.text,
      type: claim.type
    }))).toEqual([
      {
        answerEnd: answer.indexOf(texts[0]!) + texts[0]!.length,
        answerStart: answer.indexOf(texts[0]!),
        citationHandles: ["K1", "K2"],
        evidenceHandles: ["K1", "K2"],
        rangeText: texts[0],
        text: texts[0],
        type: "comparison"
      },
      {
        answerEnd: answer.indexOf(texts[1]!) + texts[1]!.length,
        answerStart: answer.indexOf(texts[1]!),
        citationHandles: ["K1", "K2"],
        evidenceHandles: ["K1", "K2"],
        rangeText: texts[1],
        text: texts[1],
        type: "comparison"
      },
      {
        answerEnd: answer.indexOf(texts[2]!) + texts[2]!.length,
        answerStart: answer.indexOf(texts[2]!),
        citationHandles: [],
        evidenceHandles: [],
        rangeText: texts[2],
        text: texts[2],
        type: "source_summary"
      },
      {
        answerEnd: answer.indexOf(texts[3]!) + texts[3]!.length,
        answerStart: answer.indexOf(texts[3]!),
        citationHandles: [],
        evidenceHandles: [],
        rangeText: texts[3],
        text: texts[3],
        type: "general_knowledge"
      }
    ]);
    expect(claims.flatMap((claim) => claim.evidenceItems.map((entry) => entry.handle)))
      .not.toContain("K3");
  });

  it("reports deleted, missing, invalid, and valid locators without repairing them", () => {
    const claims = segmentKnowledgeSemanticClaims({
      answer: "One [K1]. Two [K2]. Three [K3]. Four [K4].",
      evidence: evidence([
        item(1, "One", { state: "deleted", excerpt: null, locator: null }),
        item(2, "Two", { locator: null }),
        item(3, "Three", { locator: { page: 0 } }),
        item(4, "Four", { locator: { page: 4 } })
      ])
    });

    expect(claims.map((claim) => claim.locatorStates[0]?.state)).toEqual([
      "deleted", "missing", "invalid", "valid"
    ]);
  });

  it("strictly decodes content-free predictions and rejects cross-neighborhood attribution", () => {
    const claim = segmentKnowledgeSemanticClaims({
      answer: "Staff may work remotely [K1].",
      evidence: evidence([
        item(1, "Staff may work remotely."),
        item(2, "Unrelated evidence.")
      ])
    })[0]!;
    const prediction = {
      attributableHandles: ["K1"],
      claimOrdinal: 1,
      confidence: 0.94,
      decision: "supported",
      reasonFamily: "entailed",
      validatorProfile: "future-validator-v1",
      validatorVersion: 1,
      version: 1
    };

    expect(decodeKnowledgeSemanticGroundingPrediction(claim, prediction)).toEqual(prediction);
    expect(decodeKnowledgeSemanticGroundingPrediction(claim, {
      ...prediction,
      attributableHandles: ["K2"]
    })).toBeNull();
    expect(decodeKnowledgeSemanticGroundingPrediction(claim, {
      ...prediction,
      explanation: "raw model output is not part of the contract"
    })).toBeNull();
  });
});
