import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import { groundKnowledgeAnswer, KnowledgeAnswerContractError } from "./grounding";

function evidence(): KnowledgeEvidencePackage {
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: { expectedPassageCount: null, mode: "partial", namedTargets: [], verified: false },
    degradedFlags: [],
    items: [{
      baseName: "Base",
      contentHash: "a".repeat(64),
      contextBoundaries: {
        expanded: false,
        excerptBytes: 8,
        sourceTextBytes: 8
      },
      documentId: "source-1",
      documentVersionId: "version-1",
      excerpt: "Evidence",
      fileName: "source.txt",
      handle: "K1",
      headingPath: [],
      id: "evidence-1",
      knowledgeBaseId: "base-1",
      locator: { page: 1 },
      ordinal: 1,
      passageId: "passage-1",
      provenance: [],
      sectionId: null,
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceName: "Source",
      sourceVersionId: "version-1",
      sourceVersionNumber: 1,
      state: "available",
      textTruncated: false
    }],
    originalIntent: { kind: "focused_v1", query: "Вопрос" },
    readiness: { excludedResources: 0, readyBases: 1, readySources: 1 },
    runId: "run-1",
    scopeSnapshot: {},
    sessionId: "session-1",
    version: 2
  };
}

describe("Knowledge answer citation contract", () => {
  it("accepts ANSWERED only with a dispatched citation", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет подтвержден [K1].",
      evidence: evidence()
    });
    expect(result).toMatchObject({ outcome: "answered", finalText: "Ответ подтвержден [K1]." });
  });

  it("normalizes grouped citation syntax without rewriting prose", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nAnswer 【K1】.",
      evidence: evidence()
    });
    expect(result.finalText).toBe("Answer [K1].");
  });

  it("canonicalizes lowercase handles while preserving Markdown whitespace", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\n    code block [k1]\n",
      evidence: evidence()
    });
    expect(result.finalText).toBe("    code block [K1]\n");
  });

  it("requires the exact unpadded first-line status", () => {
    expect(() => groundKnowledgeAnswer({
      answer: " AIQSA_KB_STATUS=ANSWERED\nAnswer [K1].",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED \nAnswer [K1].",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("rejects ANSWERED without a citation", () => {
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет без ссылки.",
      evidence: evidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("accepts INSUFFICIENT_EVIDENCE without semantic phrase matching", () => {
    expect(groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\nНедостаточно данных.",
      evidence: evidence()
    }).outcome).toBe("insufficient_evidence");
  });

  it("rejects unknown handles and internal identities", () => {
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nClaim [K2].",
      evidence: evidence()
    })).toThrow("outside the final evidence manifest");
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\nsourceArtifactId leaked",
      evidence: evidence()
    })).toThrow("internal identity");
  });

  it.each([
    "evidence-1",
    "source-1",
    "version-1",
    "artifact-1",
    "passage-1",
    "a".repeat(64)
  ])("rejects the internal Knowledge identity value %s", (identity) => {
    expect(() => groundKnowledgeAnswer({
      answer: `AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\nInternal record: ${identity}`,
      evidence: evidence()
    })).toThrow("internal identity");
  });

  it.each([
    "sourceId",
    "sourceVersionId",
    "sourceArtifactId",
    "documentId",
    "knowledgeBaseSnapshotId",
    "indexGenerationId",
    "chunkId",
    "evidenceItemId",
    "modelRunId",
    "modelRunToolCallId",
    "providerAttemptId",
    "providerCallId",
    "providerResponseId",
    "profileRevisionId",
    "receiptHash",
    "idempotencyKey",
    "fusedScore",
    "vectorDistance",
    "rawScore",
    "vectorScore",
    "rerankScore",
    "confidenceScore",
    "confidenceBucket",
    "postRerankRank"
  ])("rejects the internal Knowledge field %s", (field) => {
    expect(() => groundKnowledgeAnswer({
      answer: `AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\n${field}: private`,
      evidence: evidence()
    })).toThrow("internal identity");
  });

  it("does not reject ordinary prose that describes identifiers or scoring generically", () => {
    expect(groundKnowledgeAnswer({
      answer: [
        "AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE",
        "The source identifier and ranking method are not available in the supplied evidence."
      ].join("\n"),
      evidence: evidence()
    }).outcome).toBe("insufficient_evidence");
  });
});
