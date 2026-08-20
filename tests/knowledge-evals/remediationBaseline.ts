import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KNOWLEDGE_H0_ANNOTATION_GUIDE } from "./h0AnnotationGuide";
import { assessKnowledgeH0Corpus, createKnowledgeH0CorpusManifest } from "./h0Corpus";
import { KNOWLEDGE_H0_DECISION_REGISTRY } from "./h0DecisionRegistry";
import { KNOWLEDGE_H0_REFERENCE_ENVIRONMENT } from "./h0ReferenceEnvironment";

export const KNOWLEDGE_REMEDIATION_BASELINE_VERSION = 2 as const;

export const knowledgeRemediationRegressionIds = [
  "operation_ordinal_four",
  "duplicate_source_two_bases",
  "read_source_embedding_free",
  "model_evidence_source_bound",
  "numeric_date_source_local",
  "temporal_observations_not_conflict",
  "recognized_table_row_atomic",
  "ambiguous_label_value_fail_closed",
  "dispatch_truncation_manifest_mismatch"
] as const;

export type KnowledgeRemediationRegressionId =
  typeof knowledgeRemediationRegressionIds[number];

export type KnowledgeRemediationBaselineStatus =
  | "known_gap"
  | "partially_protected"
  | "protected";

type Proof = Readonly<{
  marker: string;
  path: string;
}>;

type FindingDefinition = Readonly<{
  acceptanceIds: readonly string[];
  id: KnowledgeRemediationRegressionId;
  limitation: string | null;
  proofs: readonly Proof[];
  status: KnowledgeRemediationBaselineStatus;
}>;

const definitions: readonly FindingDefinition[] = Object.freeze([
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-01", "AC-02"]),
    id: "operation_ordinal_four",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: '"invocationOrdinal" <= 256',
        path: "prisma/migrations/20260819154500_knowledge_source_boundaries/migration.sql"
      }),
      Object.freeze({ marker: "maxOperations: 14", path: "lib/server/knowledge/knowledgeBudget.ts" }),
      Object.freeze({
        marker: "!integer(value.maxOperations, 1, 256)",
        path: "lib/server/knowledge/knowledgeBudget.ts"
      }),
      Object.freeze({
        marker: "allows operation ordinal %i under the versioned default policy",
        path: "lib/server/knowledge/knowledgeBudget.test.ts"
      }),
      Object.freeze({
        marker: "accepts representative persisted ordinals through 256 but rejects 257",
        path: "lib/server/knowledge/knowledgeBudget.prisma.test.ts"
      }),
      Object.freeze({
        marker: "applies the default operation policy before side effects at ordinal $invocationOrdinal",
        path: "lib/server/knowledge/toolExecutor.test.ts"
      }),
      Object.freeze({
        marker: "settles a preflight-rejected Knowledge operation without egress or execution",
        path: "lib/server/runs/runExecution.test.ts"
      }),
      Object.freeze({
        marker: "settles a recovered Knowledge preflight rejection without Knowledge egress",
        path: "lib/server/runs/runRecovery.test.ts"
      }),
      Object.freeze({
        marker: "replays a committed read receipt during recovery without Knowledge egress or execution",
        path: "lib/server/runs/runRecovery.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-03"]),
    id: "duplicate_source_two_bases",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: "canonicalizeKnowledgeSourceCandidates",
        path: "lib/server/knowledge/canonicalSourceCandidates.ts"
      }),
      Object.freeze({
        marker: "collapses A+B admission without duplicate ranking signals and retains sorted provenance",
        path: "lib/server/knowledge/canonicalSourceCandidates.test.ts"
      }),
      Object.freeze({
        marker: "returns one non-inflated candidate for the same artifact admitted through Bases A+B",
        path: "lib/server/knowledge/prismaRetrievalCore.canonical.test.ts"
      }),
      Object.freeze({
        marker: "version: KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION",
        path: "lib/server/knowledge/prismaRetrievalRepository.ts"
      }),
      Object.freeze({
        marker: "retrieves a direct-only Source, deduplicates Bases A+B, and replays a persisted read",
        path: "lib/server/knowledge/prismaRetrievalRepository.canonical.prisma.test.ts"
      }),
      Object.freeze({
        marker: "analyzes one canonical artifact admitted through Bases A+B and retains provenance",
        path: "lib/server/knowledge/prismaRetrievalRepository.structured.test.ts"
      }),
      Object.freeze({
        marker: "collapses duplicate artifact projections before structured or visual analysis",
        path: "lib/server/knowledge/canonicalSourceCandidates.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-06"]),
    id: "read_source_embedding_free",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: 'if (request.operation === "read_source")',
        path: "lib/server/knowledge/toolExecutor.ts"
      }),
      Object.freeze({
        marker: "reads one admitted Source deterministically without an embedding call",
        path: "lib/server/knowledge/toolExecutor.test.ts"
      }),
      Object.freeze({
        marker: "resolves a page inside one admitted Source and returns only a bounded neighbor window",
        path: "lib/server/knowledge/prismaRetrievalRepository.readSource.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-04"]),
    id: "model_evidence_source_bound",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: "KNOWLEDGE_RESULT_VERSION = 2",
        path: "lib/server/knowledge/retrievalTypes.ts"
      }),
      Object.freeze({
        marker: "--- BEGIN SOURCE EVIDENCE ${result.handle} ---",
        path: "lib/server/knowledge/toolResult.ts"
      }),
      Object.freeze({
        marker: "renders every V2 handle as an atomic Source-bound block without leaking identity keys",
        path: "lib/server/knowledge/toolResult.versioning.test.ts"
      }),
      Object.freeze({
        marker: "rejects V2 passages missing %s instead of fabricating it",
        path: "lib/server/knowledge/toolResult.versioning.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-05"]),
    id: "numeric_date_source_local",
    limitation: "Typed document context is authoritative when available; immutable legacy evidence without documentContext retains the existing Source-local lexical fallback.",
    proofs: Object.freeze([
      Object.freeze({ marker: "sourceLocalNumericAssessment", path: "lib/server/knowledge/grounding.ts" }),
      Object.freeze({
        marker: "assessKnowledgeObservationGroundingV1",
        path: "lib/server/knowledge/grounding.ts"
      }),
      Object.freeze({
        marker: "rejects cross-Source date/value mixing even when every handle is valid",
        path: "lib/server/knowledge/grounding.test.ts"
      }),
      Object.freeze({
        marker: "uses typed roles instead of accepting an actual/reference lexical swap",
        path: "lib/server/knowledge/grounding.test.ts"
      }),
      Object.freeze({
        marker: "normalizes RU decimal comma but rejects locale-ambiguous thousands in typed context",
        path: "lib/server/knowledge/grounding.test.ts"
      }),
      Object.freeze({
        marker: "binds actual and reference values to their explicit roles",
        path: "lib/server/knowledge/observationGrounding.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-20", "AC-24"]),
    id: "temporal_observations_not_conflict",
    limitation: "This is deterministic seam protection only; AC-24 held-out temporal quality remains release-ineligible until independent blinded human labels and adjudication are imported.",
    proofs: Object.freeze([
      Object.freeze({
        marker: "KnowledgeDocumentObservationV1",
        path: "lib/server/knowledge/documentContext.ts"
      }),
      Object.freeze({
        marker: "binds actual and reference values to the same explicit table metric, unit, and date",
        path: "lib/server/knowledge/documentContext.test.ts"
      }),
      Object.freeze({
        marker: "checks effective interval endpoints on the same observation",
        path: "lib/server/knowledge/observationGrounding.test.ts"
      }),
      Object.freeze({
        marker: "binds explicit English and Russian Source version claims to evidence metadata",
        path: "lib/server/knowledge/observationGrounding.test.ts"
      }),
      Object.freeze({
        marker: "keeps dated measurements as a timeline instead of treating them as a conflict",
        path: "lib/server/knowledge/grounding.test.ts"
      }),
      Object.freeze({
        marker: "keeps same-unit observations separated by typed metric and date",
        path: "lib/server/knowledge/grounding.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-18"]),
    id: "recognized_table_row_atomic",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: "function profile4TableSegments",
        path: "lib/server/knowledge/chunking.ts"
      }),
      Object.freeze({
        marker: "keeps table rows intact and carries exact block provenance",
        path: "lib/server/knowledge/chunking.test.ts"
      }),
      Object.freeze({
        marker: "repeats a detected header and preserves its row lineage after a page-style repetition",
        path: "lib/server/knowledge/chunking.test.ts"
      }),
      Object.freeze({
        marker: "projects an oversized row by bounded column groups with one stable original-row identity",
        path: "lib/server/knowledge/chunking.test.ts"
      }),
      Object.freeze({
        marker: "resolves one typed table-row locator to its complete ordered projection group",
        path: "lib/server/knowledge/prismaRetrievalRepository.readSource.test.ts"
      }),
      Object.freeze({
        marker: "fails closed for an incomplete or over-limit table-row projection group",
        path: "lib/server/knowledge/prismaRetrievalRepository.readSource.test.ts"
      }),
      Object.freeze({
        marker: "opens only the exact original table row with its repeated header lineage",
        path: "lib/server/knowledge/citationViewer.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-19"]),
    id: "ambiguous_label_value_fail_closed",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: "preserves bounded form and key/value graphs without inventing pairs",
        path: "lib/server/parsing/normalization.test.ts"
      }),
      Object.freeze({
        marker: "round-trips immutable field graphs with stable IDs and detects cell tampering",
        path: "lib/server/knowledge/normalizedDocument.test.ts"
      }),
      Object.freeze({
        marker: "keeps competing or unlinked field cells separate and explicitly ambiguous",
        path: "lib/server/knowledge/documentContext.test.ts"
      }),
      Object.freeze({
        marker: "chunks only parser-linked field pairs atomically and isolates competing cells",
        path: "lib/server/knowledge/chunking.test.ts"
      }),
      Object.freeze({
        marker: "does not fall back to excerpt matching when typed context is ambiguous",
        path: "lib/server/knowledge/grounding.test.ts"
      }),
      Object.freeze({
        marker: "opens an explicitly linked form pair without exposing graph identities",
        path: "lib/server/knowledge/citationViewer.test.ts"
      })
    ]),
    status: "protected"
  }),
  Object.freeze({
    acceptanceIds: Object.freeze(["AC-09"]),
    id: "dispatch_truncation_manifest_mismatch",
    limitation: null,
    proofs: Object.freeze([
      Object.freeze({
        marker: "excludes an oversized exact excerpt whole without partial JSON or XML",
        path: "lib/server/knowledge/evidenceDispatchManifest.test.ts"
      }),
      Object.freeze({
        marker: "dispatches a fresh immutable manifest after follow-up Knowledge without duplicating evidence in the tool transcript",
        path: "lib/server/runs/runExecution.test.ts"
      }),
      Object.freeze({
        marker: "never lets evidence excluded from the final settled manifest support an answer",
        path: "lib/server/knowledge/evidenceRepository.test.ts"
      }),
      Object.freeze({
        marker: "rebuilds and dispatches an expired non-checkpointed RESERVED attempt exactly once",
        path: "lib/server/runs/runRecovery.test.ts"
      })
    ]),
    status: "protected"
  })
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function collectKnowledgeRemediationBaseline(root = process.cwd()): Promise<Readonly<{
  annotation: Readonly<{
    minimumIndependentAnnotators: number;
    releaseEvidence: typeof KNOWLEDGE_H0_ANNOTATION_GUIDE.releaseEvidence;
    status: typeof KNOWLEDGE_H0_ANNOTATION_GUIDE.status;
  }>;
  corpus: Readonly<{
    assessment: ReturnType<typeof assessKnowledgeH0Corpus>;
    sha256: string;
    version: string;
  }>;
  decisionRegistry: Readonly<{
    inactiveBehaviorDocumentedAsLive: false;
    pendingDecisionCount: number;
    version: string;
  }>;
  findingCounts: Readonly<Record<KnowledgeRemediationBaselineStatus, number>>;
  findings: readonly Readonly<{
    acceptanceIds: readonly string[];
    evidence: readonly Readonly<{ path: string; sha256: string }>[];
    id: KnowledgeRemediationRegressionId;
    limitation: string | null;
    status: KnowledgeRemediationBaselineStatus;
  }>[];
  privateContentIncluded: false;
  realEmbeddingQualityEvidence: false;
  referenceEnvironment: typeof KNOWLEDGE_H0_REFERENCE_ENVIRONMENT;
  releaseQualityEligible: false;
  version: typeof KNOWLEDGE_REMEDIATION_BASELINE_VERSION;
}>> {
  const paths = [...new Set(definitions.flatMap((definition) =>
    definition.proofs.map((proof) => proof.path)))].sort();
  const bodies = new Map(await Promise.all(paths.map(async (path) => [
    path,
    await readFile(join(root, path), "utf8")
  ] as const)));
  const findings = definitions.map((definition) => {
    for (const proof of definition.proofs) {
      if (!bodies.get(proof.path)?.includes(proof.marker)) {
        throw new Error(`knowledge_remediation_baseline_proof_drift:${definition.id}:${proof.path}`);
      }
    }
    return Object.freeze({
      acceptanceIds: definition.acceptanceIds,
      evidence: Object.freeze([...new Set(definition.proofs.map((proof) => proof.path))]
        .sort()
        .map((path) => Object.freeze({ path, sha256: sha256(bodies.get(path)!) }))),
      id: definition.id,
      limitation: definition.limitation,
      status: definition.status
    });
  });
  const findingCounts = Object.freeze({
    known_gap: findings.filter((finding) => finding.status === "known_gap").length,
    partially_protected: findings.filter((finding) =>
      finding.status === "partially_protected").length,
    protected: findings.filter((finding) => finding.status === "protected").length
  });
  const corpus = createKnowledgeH0CorpusManifest();
  return Object.freeze({
    annotation: Object.freeze({
      minimumIndependentAnnotators:
        KNOWLEDGE_H0_ANNOTATION_GUIDE.independence.minimumAnnotatorsPerRepresentativeItem,
      releaseEvidence: KNOWLEDGE_H0_ANNOTATION_GUIDE.releaseEvidence,
      status: KNOWLEDGE_H0_ANNOTATION_GUIDE.status
    }),
    corpus: Object.freeze({
      assessment: assessKnowledgeH0Corpus(corpus),
      sha256: corpus.corpusSha256,
      version: corpus.version
    }),
    decisionRegistry: Object.freeze({
      inactiveBehaviorDocumentedAsLive:
        KNOWLEDGE_H0_DECISION_REGISTRY.inactiveBehaviorDocumentedAsLive,
      pendingDecisionCount: KNOWLEDGE_H0_DECISION_REGISTRY.decisions.length,
      version: KNOWLEDGE_H0_DECISION_REGISTRY.version
    }),
    findingCounts,
    findings: Object.freeze(findings),
    privateContentIncluded: false,
    realEmbeddingQualityEvidence: false,
    referenceEnvironment: KNOWLEDGE_H0_REFERENCE_ENVIRONMENT,
    releaseQualityEligible: false,
    version: KNOWLEDGE_REMEDIATION_BASELINE_VERSION
  });
}
