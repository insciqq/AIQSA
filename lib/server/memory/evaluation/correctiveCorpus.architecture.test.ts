import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_RETRIEVAL_PIPELINE_VERSION } from
  "../../../domain/memory/retrieval/config";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../history/contract";
import {
  MEMORY_CHAT_DIGEST_POLICY_VERSION,
  MEMORY_CHAT_DIGEST_PROMPT_VERSION,
  MEMORY_CHAT_DIGEST_SCHEMA_VERSION
} from "../history/digest";
import { MEMORY_ENTITY_RESOLUTION_VERSION } from
  "../learning/entities/normalization";
import {
  MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION
} from "../learning/extraction/adjudication";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
} from "../learning/extraction/contract";
import { MEMORY_ENTITY_SLOT_IDENTITY_VERSION } from
  "../learning/identity/normalization";
import {
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  MEMORY_FACT_RELATION_POLICY_VERSION,
  MEMORY_FACT_RELATION_PROMPT_VERSION,
  MEMORY_FACT_RELATION_SCHEMA_VERSION
} from "../learning/relations/policy";
import { MEMORY_TEMPORAL_RESOLVER_VERSION } from
  "../learning/temporal/resolver";
import {
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_PROMPT_VERSION,
  MEMORY_SYNTHESIS_SCHEMA_VERSION
} from "../synthesis/policy";

type ScenarioId = `E0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
type EvidenceKind =
  | "concurrency"
  | "database"
  | "operational"
  | "provider_budget"
  | "query_plan"
  | "runtime";

type EvidenceAnchor = Readonly<{
  anchor: string;
  kind: EvidenceKind;
  path: string;
}>;

type CorrectiveScenario = Readonly<{
  evidence: readonly EvidenceAnchor[];
  id: ScenarioId;
  providerCallBudget: Readonly<Record<string, number | undefined>>;
}>;

const corpus: readonly CorrectiveScenario[] = Object.freeze([
  {
    evidence: [
      {
        anchor: "[E01] executes the Finnish, Spanish, Japanese and mixed-language set",
        kind: "runtime",
        path: "learning/extraction/decoder.vnext.test.ts"
      },
      {
        anchor: "[E02] commits direct Dutch ownership with exact evidence and deduplicates retry",
        kind: "database",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E01] applies identical code policy to multilingual/noisy packets",
        kind: "provider_budget",
        path: "learning/extraction/decoder.vnext.test.ts"
      },
      {
        anchor: "[E01] preserves repeated exact occurrences with UTF-16 offsets",
        kind: "operational",
        path: "learning/extraction/decoder.vnext.test.ts"
      }
    ],
    id: "E01",
    providerCallBudget: { adjudication: 0, extraction: 0 }
  },
  {
    evidence: [
      {
        anchor: "[E02] rejects five ownership false positives and admits one direct statement",
        kind: "runtime",
        path: "learning/extraction/decoder.vnext.test.ts"
      },
      {
        anchor: "[E02] commits direct Dutch ownership with exact evidence and deduplicates retry",
        kind: "database",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E02] uses one extraction and one batched high-risk adjudication",
        kind: "provider_budget",
        path: "learning/extraction/handler.test.ts"
      },
      {
        anchor: "[E02] commits direct Dutch ownership with exact evidence and deduplicates retry",
        kind: "operational",
        path: "learning/extraction/repository.prisma.test.ts"
      }
    ],
    id: "E02",
    providerCallBudget: { adjudication: 1, extraction: 1 }
  },
  {
    evidence: [
      {
        anchor: "[E03] resolves a cross-language context reference to one entity-backed fact",
        kind: "database",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] preserves one multilingual product lifecycle and merges richer detail",
        kind: "runtime",
        path: "learning/relations/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] preserves one multilingual product lifecycle and merges richer detail",
        kind: "provider_budget",
        path: "learning/relations/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] reuses one cross-language entity, excludes pronouns, and proves lookup plans",
        kind: "query_plan",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] converges a concurrent production merge for an adjudicated alias collision",
        kind: "concurrency",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "serializes competing current-pointer updates",
        kind: "concurrency",
        path: "learning/relations/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] preserves one multilingual product lifecycle and merges richer detail",
        kind: "operational",
        path: "learning/relations/repository.prisma.test.ts"
      }
    ],
    id: "E03",
    providerCallBudget: { relationAuxiliary: 0 }
  },
  {
    evidence: [
      {
        anchor: "[E04] recovers a three-candidate staged packet after a post-first-candidate fault",
        kind: "database",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E04] recovers staged accepted output with zero provider calls",
        kind: "provider_budget",
        path: "learning/extraction/handler.test.ts"
      },
      {
        anchor: "[E04] converges concurrent staged recovery without duplicate rows",
        kind: "concurrency",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E04] fences a staged apply behind a concurrent Memory reset",
        kind: "runtime",
        path: "learning/extraction/repository.prisma.test.ts"
      },
      {
        anchor: "[E04] recovers a three-candidate staged packet after a post-first-candidate fault",
        kind: "operational",
        path: "learning/extraction/repository.prisma.test.ts"
      }
    ],
    id: "E04",
    providerCallBudget: { recoveryExtraction: 0 }
  },
  {
    evidence: [
      {
        anchor: "[E05] keeps one support and fences alias retrieval at the final invalidation",
        kind: "database",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "[E05] keeps one support and fences alias retrieval at the final invalidation",
        kind: "runtime",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "[E05] keeps one support and fences alias retrieval at the final invalidation",
        kind: "concurrency",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "[E03] reuses one cross-language entity, excludes pronouns, and proves lookup plans",
        kind: "query_plan",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "materializeMemoryCandidateEntityIdentity",
        kind: "provider_budget",
        path: "learning/entities/repository.prisma.test.ts"
      },
      {
        anchor: "retractUnsupportedAutomaticMemoryEntities",
        kind: "operational",
        path: "learning/entities/repository.prisma.test.ts"
      }
    ],
    id: "E05",
    providerCallBudget: { provider: 0 }
  },
  {
    evidence: [
      {
        anchor: "[E06] synthesizes, retrieves, invalidates, and replaces a source-bound pattern",
        kind: "database",
        path: "synthesis/repository.prisma.test.ts"
      },
      {
        anchor: "[E06] builds a bounded ref-only prompt with untrusted source labels",
        kind: "runtime",
        path: "synthesis/contract.test.ts"
      },
      {
        anchor: "[E06] performs one governed synthesis call, stages, reauthorizes, and applies",
        kind: "provider_budget",
        path: "synthesis/handler.test.ts"
      },
      {
        anchor: "replacementRace",
        kind: "concurrency",
        path: "synthesis/repository.prisma.test.ts"
      },
      {
        anchor: "proves the production HNSW plan, bounded exact plan, and pinned database profile",
        kind: "query_plan",
        path: "retrieval/vector.prisma.test.ts"
      },
      {
        anchor: "compatibleAutomaticFactVersions: 2",
        kind: "operational",
        path: "synthesis/repository.prisma.test.ts"
      }
    ],
    id: "E06",
    providerCallBudget: { initialSynthesis: 1, stagedRecoveryAdditional: 0 }
  },
  {
    evidence: [
      {
        anchor: "[E07] retrieves one canonical current pointer or deduplicated genuine history",
        kind: "database",
        path: "retrieval/localRepository.prisma.test.ts"
      },
      {
        anchor: "[E07] keeps authoritative candidates when one signal degrades",
        kind: "runtime",
        path: "retrieval/runAdmission.test.ts"
      },
      {
        anchor: "[E07] preserves exact current facts in RRF fallback",
        kind: "provider_budget",
        path: "retrieval/runAdmission.test.ts"
      },
      {
        anchor: "[E07] proves bounded canonical authority, history, entity, FTS, and expiry plans",
        kind: "query_plan",
        path: "retrieval/localRepository.prisma.test.ts"
      },
      {
        anchor: "[E07] lets mandatory final authority remove a degraded exact candidate",
        kind: "operational",
        path: "retrieval/runAdmission.test.ts"
      }
    ],
    id: "E07",
    providerCallBudget: { rerankerPerAdmission: 1 }
  },
  {
    evidence: [
      {
        anchor: "[E08] bounds a 4,000-message append to the indexed tail plus contextual overlap",
        kind: "database",
        path: "history/repository.prisma.test.ts"
      },
      {
        anchor: "[E08] retains early and late digest coverage while dropping edited content",
        kind: "runtime",
        path: "history/digest.test.ts"
      },
      {
        anchor: "[E08] bounds edit and branch divergence to one maximum chunk plus overlap",
        kind: "runtime",
        path: "history/incremental.test.ts"
      },
      {
        anchor: "[E08] reuses an unchanged digest with zero provider executions",
        kind: "provider_budget",
        path: "history/digest.test.ts"
      },
      {
        anchor: "ChatMemoryCheckpointMessage_user_chat_ordinal_key",
        kind: "query_plan",
        path: "history/repository.prisma.test.ts"
      },
      {
        anchor: "messageContentRowsLoaded: 6",
        kind: "operational",
        path: "history/repository.prisma.test.ts"
      }
    ],
    id: "E08",
    providerCallBudget: { unchangedDigest: 0 }
  }
]);

const legacyDispositions = Object.freeze([
  {
    disposition: "RETAINED_DORMANT_EXCLUDED",
    subsystem: "unsupported_automatic_fact_pipelines"
  },
  {
    disposition: "RETAINED_DORMANT_EXCLUDED",
    subsystem: "legacy_candidates_and_decisions"
  },
  {
    disposition: "TERMINALIZED_UNCLAIMED",
    subsystem: "legacy_consolidate_and_verify_jobs"
  },
  {
    disposition: "REMOVED_FROM_ACTIVE_RUNTIME",
    subsystem: "legacy_semantic_handlers_and_producers"
  },
  {
    disposition: "AUTHORITY_FENCED_RETRACTABLE",
    subsystem: "unsupported_aliases_and_dependencies"
  }
]);

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), "lib/server/memory", path), "utf8");
}

describe("Memory corrective E01-E08 corpus inventory", () => {
  it("binds every scenario to executable runtime, database, budget and count evidence", () => {
    expect(corpus.map(({ id }) => id)).toEqual([
      "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08"
    ]);
    for (const scenario of corpus) {
      const kinds = new Set(scenario.evidence.map(({ kind }) => kind));
      expect([
        "database",
        "operational",
        "provider_budget",
        "runtime"
      ].every((kind) => kinds.has(kind as EvidenceKind)), scenario.id).toBe(true);
      expect(Object.values(scenario.providerCallBudget).every((value) =>
        value !== undefined && Number.isSafeInteger(value) && value >= 0),
      scenario.id).toBe(true);
      for (const evidence of scenario.evidence) {
        expect(source(evidence.path), `${scenario.id}:${evidence.kind}`)
          .toContain(evidence.anchor);
      }
    }
  });

  it("records an explicit disposition for every retired semantic subsystem", () => {
    expect(new Set(legacyDispositions.map(({ subsystem }) => subsystem)).size)
      .toBe(legacyDispositions.length);
    expect(legacyDispositions.every(({ disposition }) =>
      disposition.length > 0)).toBe(true);
  });

  it("pins every behavior-changing corrective pipeline version", () => {
    expect({
      adjudication: [
        MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
        MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
        MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
        MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION
      ],
      digest: [
        MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
        MEMORY_CHAT_DIGEST_POLICY_VERSION,
        MEMORY_CHAT_DIGEST_PROMPT_VERSION,
        MEMORY_CHAT_DIGEST_SCHEMA_VERSION
      ],
      entity: [MEMORY_ENTITY_RESOLUTION_VERSION, MEMORY_ENTITY_SLOT_IDENTITY_VERSION],
      extraction: [
        MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        MEMORY_FACT_EXTRACTION_POLICY_VERSION,
        MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
        MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
      ],
      history: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      relation: [
        MEMORY_FACT_RELATION_PIPELINE_VERSION,
        MEMORY_FACT_RELATION_POLICY_VERSION,
        MEMORY_FACT_RELATION_PROMPT_VERSION,
        MEMORY_FACT_RELATION_SCHEMA_VERSION
      ],
      retrieval: MEMORY_RETRIEVAL_PIPELINE_VERSION,
      synthesis: [
        MEMORY_SYNTHESIS_PIPELINE_VERSION,
        MEMORY_SYNTHESIS_POLICY_VERSION,
        MEMORY_SYNTHESIS_PROMPT_VERSION,
        MEMORY_SYNTHESIS_SCHEMA_VERSION
      ],
      temporal: MEMORY_TEMPORAL_RESOLVER_VERSION
    }).toEqual({
      adjudication: [
        "memory-semantic-adjudication-v1",
        "memory-semantic-adjudication-policy-v2",
        "memory-semantic-adjudication-prompt-v3",
        "memory-semantic-adjudication-schema-v1"
      ],
      digest: [
        "memory-chat-digest-v5",
        "memory-chat-digest-policy-v4",
        "memory-chat-digest-prompt-v5",
        "memory-chat-digest-schema-v2"
      ],
      entity: ["memory-entity-resolution-v2", "slot-v3"],
      extraction: [
        "memory-fact-extraction-vnext-v7",
        "memory-fact-extraction-policy-v10",
        "memory-fact-extraction-prompt-v26",
        "memory-fact-extraction-schema-v5"
      ],
      history: "memory-history-incremental-v5",
      relation: [
        "memory-fact-relation-v2",
        "memory-fact-relation-policy-v3",
        "memory-fact-relation-prompt-v1",
        "memory-fact-relation-schema-v1"
      ],
      retrieval: "memory-personal-retrieval-v20",
      synthesis: [
        "memory-synthesis-v2",
        "memory-synthesis-policy-v2",
        "memory-synthesis-prompt-v3",
        "memory-synthesis-schema-v2"
      ],
      temporal: "memory-temporal-resolution-v3"
    });
  });
});
