import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  groundKnowledgeAnswer,
  groundKnowledgeToolLoopAnswer,
  KnowledgeAnswerContractError
} from "./grounding";

const privateSourceId = "2e3aa829-79cd-41df-b5c7-1a53f4b5cf19";

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
      sourceId: privateSourceId,
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

function toolLoopEvidence(): KnowledgeEvidencePackage {
  const base = evidence();
  return {
    ...base,
    items: [
      ...base.items,
      {
        ...base.items[0]!,
        handle: "K2",
        id: "evidence-2",
        ordinal: 2,
        passageId: "passage-2"
      }
    ],
    originalIntent: { kind: "tool_loop_v1" }
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

  it("normalizes the provider-native wrapped citation syntax", () => {
    const result = groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nОтвет citeK1.",
      evidence: evidence()
    });
    expect(result.finalText).toBe("Ответ [K1].");
  });

  it("normalizes unambiguous provider wrapper separator variants", () => {
    const current = toolLoopEvidence();
    for (const wrapper of [
      "citeK1, K2",
      "citeK1; K2",
      "cite[K1] and 【K2】",
      "citeK1 K2"
    ]) {
      expect(groundKnowledgeAnswer({
        answer: `AIQSA_KB_STATUS=ANSWERED\nSupported ${wrapper}.`,
        evidence: current
      }).finalText).toBe("Supported [K1][K2].");
    }
  });

  it("fails closed for malformed or unknown provider-native citation wrappers", () => {
    for (const answer of [
      "Ответ citeK2.",
      "Ответ citeK1.",
      "Ответ citeK1-K2.",
      "Ответ citeK1 unsupported K2."
    ]) {
      expect(() => groundKnowledgeAnswer({
        answer: `AIQSA_KB_STATUS=ANSWERED\n${answer}`,
        evidence: evidence()
      })).toThrow(KnowledgeAnswerContractError);
    }
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

  it("rejects unknown handles", () => {
    expect(() => groundKnowledgeAnswer({
      answer: "AIQSA_KB_STATUS=ANSWERED\nClaim [K2].",
      evidence: evidence()
    })).toThrow("outside the final evidence manifest");
  });

  it.each([
    "evidence-1",
    "source-1",
    privateSourceId,
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

  it("allows technical field names without exposing concrete private values", () => {
    const body = "The sourceId, documentId, contentHash, and confidenceScore fields are documented.";
    expect(groundKnowledgeAnswer({
      answer: `AIQSA_KB_STATUS=INSUFFICIENT_EVIDENCE\n${body}`,
      evidence: evidence()
    }).finalText).toBe(body);
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

describe("Knowledge tool-loop citation contract", () => {
  it("keeps ordinary Markdown and permits an answer without a Knowledge citation", () => {
    const answer = "## Result\n\nNo selected Knowledge passage was needed; see [web](https://example.test).";
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    })).toMatchObject({ finalText: answer, outcome: "answered" });
  });

  it.each([
    "[Knowledge Base](https://example.test/knowledge)",
    "[Kubernetes docs](https://example.test/kubernetes)",
    "[K8s docs](https://example.test/k8s)",
    "[Key findings]"
  ])("keeps non-citation Markdown beginning with K: %s", (answer) => {
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it.each([
    "Vitamin K2 is discussed in the source.",
    "A K1 visa is a distinct term.",
    "Form K1 is available online.",
    "Bare K999 is not citation syntax."
  ])("keeps a bare K-number term as ordinary prose: %s", (answer) => {
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it("allows field terminology but rejects concrete private UUIDs and hashes", () => {
    const current = toolLoopEvidence();
    const safeAnswer = "The sourceId field contains an identifier.";
    expect(groundKnowledgeToolLoopAnswer({
      answer: safeAnswer,
      evidence: current
    }).finalText).toBe(safeAnswer);

    for (const identity of [privateSourceId, "a".repeat(64)]) {
      expect(() => groundKnowledgeToolLoopAnswer({
        answer: `Internal record: ${identity}`,
        evidence: current
      })).toThrow("internal Knowledge identity");
    }
  });

  it("accepts mixed Knowledge and Web citations", () => {
    const answer = "The policy says 30 days [K1], while the current web page says 45 days [W1].";
    expect(groundKnowledgeToolLoopAnswer({
      answer,
      evidence: toolLoopEvidence()
    }).finalText).toBe(answer);
  });

  it("narrowly normalizes a comma group only when every handle is valid", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Supported by both passages [K1, K2].",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Supported by both passages [K1][K2].");
    expect(() => groundKnowledgeToolLoopAnswer({
      answer: "Unsupported group [K1, K3].",
      evidence: toolLoopEvidence()
    })).toThrow(KnowledgeAnswerContractError);
  });

  it("normalizes provider full-width citation brackets in an ordinary tool-loop answer", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Подтверждено 【K2】【K1】.",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Подтверждено [K2][K1].");
  });

  it("normalizes a multi-handle provider-native wrapper", () => {
    expect(groundKnowledgeToolLoopAnswer({
      answer: "Supported citeK2K1.",
      evidence: toolLoopEvidence()
    }).finalText).toBe("Supported [K2][K1].");
  });

  it("rejects unknown, deleted, non-dispatched, and malformed handles", () => {
    const current = toolLoopEvidence();
    const deleted: KnowledgeEvidencePackage = {
      ...current,
      items: current.items.map((item, index) => index === 0
        ? { ...item, state: "deleted" as const }
        : item)
    };
    for (const [answer, selectedEvidence] of [
      ["Unknown [K999].", toolLoopEvidence()],
      ["Deleted [K1].", deleted],
      ["Malformed [K0].", toolLoopEvidence()],
      ["Malformed [K01].", toolLoopEvidence()],
      ["Malformed [K1 and K2].", toolLoopEvidence()],
      ["Malformed 【K0】.", toolLoopEvidence()]
    ] as const) {
      expect(() => groundKnowledgeToolLoopAnswer({
        answer,
        evidence: selectedEvidence
      })).toThrow(KnowledgeAnswerContractError);
    }
  });
});
