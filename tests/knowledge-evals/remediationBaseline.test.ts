import { describe, expect, it } from "vitest";
import {
  collectKnowledgeRemediationBaseline,
  knowledgeRemediationRegressionIds
} from "./remediationBaseline";

describe("Knowledge remediation frozen baseline", () => {
  it("owns every H0 regression with content-free executable proof", async () => {
    const report = await collectKnowledgeRemediationBaseline();

    expect(report).toMatchObject({
      annotation: {
        minimumIndependentAnnotators: 2,
        releaseEvidence: { eligible: false },
        status: "frozen_guide_unexecuted"
      },
      corpus: {
        assessment: { releaseQualityEligible: false },
        version: "knowledge-hardening-h0-corpus-v1"
      },
      decisionRegistry: {
        inactiveBehaviorDocumentedAsLive: false,
        pendingDecisionCount: 10
      },
      findingCounts: {
        known_gap: 0,
        partially_protected: 0,
        protected: 9
      },
      privateContentIncluded: false,
      realEmbeddingQualityEvidence: false,
      releaseQualityEligible: false,
      version: 2
    });
    expect(report.findings.map((finding) => finding.id))
      .toEqual(knowledgeRemediationRegressionIds);
    expect(report.findings.every((finding) =>
      finding.acceptanceIds.length > 0 &&
      finding.evidence.length > 0 &&
      finding.evidence.every(({ path, sha256 }) =>
        path.length > 0 && /^[0-9a-f]{64}$/u.test(sha256)) &&
      (finding.status === "protected" || Boolean(finding.limitation))
    )).toBe(true);
  });

  it("keeps deterministic H5 seam protection separate from human release evidence", async () => {
    const report = await collectKnowledgeRemediationBaseline();
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));

    expect(byId.get("duplicate_source_two_bases")?.status).toBe("protected");
    expect(byId.get("dispatch_truncation_manifest_mismatch")?.status).toBe("protected");
    expect(byId.get("operation_ordinal_four")?.status).toBe("protected");
    expect(byId.get("numeric_date_source_local")?.status).toBe("protected");
    expect(byId.get("temporal_observations_not_conflict")?.status).toBe("protected");
    expect(byId.get("recognized_table_row_atomic")?.status).toBe("protected");
    expect(byId.get("ambiguous_label_value_fail_closed")?.status).toBe("protected");
    expect(byId.get("read_source_embedding_free")?.status).toBe("protected");
    expect(byId.get("model_evidence_source_bound")?.status).toBe("protected");
    expect(byId.get("temporal_observations_not_conflict")?.limitation)
      .toContain("independent blinded human labels and adjudication");
    expect(report.annotation.releaseEvidence.eligible).toBe(false);
    expect(report.corpus.assessment.releaseQualityEligible).toBe(false);
    expect(report.realEmbeddingQualityEvidence).toBe(false);
    expect(report.releaseQualityEligible).toBe(false);
  });
});
