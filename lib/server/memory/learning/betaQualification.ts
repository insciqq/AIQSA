import type { MemoryEvaluationLanguage } from "../../../evaluation/memory/contracts";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from "../embedding/contract";
import type {
  MemoryExecutionVersions,
  MemoryQualificationAuthority
} from "../execution/qualification";
import { qualifyMemoryExecution } from "../execution/qualification";
import type { ResolvedMemoryUtilityPolicy } from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import { MEMORY_EPISODE_EXTRACTION_VERSIONS } from "../history/episode/contract";
import { MEMORY_QUERY_EMBEDDING_VERSIONS } from "../retrieval/runUtilities";
import {
  MEMORY_FACT_CONSOLIDATION_VERSIONS,
  MEMORY_FACT_VERIFICATION_VERSIONS
} from "./consolidation/contract";
import { MEMORY_FACT_EXTRACTION_VERSIONS } from "./extraction/contract";

export const MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES = [
  "MEMORY_CONSOLIDATE",
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_EPISODE_EXTRACT",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_QUERY_EMBED",
  "MEMORY_VERIFY"
] as const satisfies readonly MemoryExecutionRole[];

export function memoryAutomaticLearningVersions(
  role: (typeof MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES)[number]
): MemoryExecutionVersions {
  switch (role) {
    case "MEMORY_CONSOLIDATE":
      return MEMORY_FACT_CONSOLIDATION_VERSIONS;
    case "MEMORY_DOCUMENT_EMBED":
      return MEMORY_ITEM_EMBEDDING_VERSIONS;
    case "MEMORY_EPISODE_EXTRACT":
      return MEMORY_EPISODE_EXTRACTION_VERSIONS;
    case "MEMORY_FACT_EXTRACT":
      return MEMORY_FACT_EXTRACTION_VERSIONS;
    case "MEMORY_QUERY_EMBED":
      return MEMORY_QUERY_EMBEDDING_VERSIONS;
    case "MEMORY_VERIFY":
      return MEMORY_FACT_VERIFICATION_VERSIONS;
  }
}

/** Phase 6 is one capability, not a collection of independently degradable
 * provider calls. Every role exercised by the qualified topology must match
 * the current signed authority before Settings may advertise automatic
 * learning. The execution boundary repeats this check immediately before I/O. */
export function memoryAutomaticLearningIsQualified(input: Readonly<{
  authority: MemoryQualificationAuthority;
  language: MemoryEvaluationLanguage;
  now: Date;
  policy: ResolvedMemoryUtilityPolicy;
}>): boolean {
  for (const role of MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES) {
    const target = input.policy.targets.get(role);
    if (!target) return false;
    try {
      qualifyMemoryExecution({
        authority: input.authority,
        now: input.now,
        role,
        settings: { memoryUiLocale: input.language },
        target,
        versions: memoryAutomaticLearningVersions(role)
      });
    } catch {
      return false;
    }
  }
  return true;
}
