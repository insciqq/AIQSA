import { verify } from "node:crypto";
import {
  MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY,
  MEMORY_CAPABILITY_QUALIFICATION_REGISTRY
} from "../../../evaluation/memory/qualification";
import {
  MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
  MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
  MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
} from "../../../evaluation/memory/automaticLearning";
import {
  MEMORY_PHASE7_CORPUS_VERSION,
  MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
  MEMORY_PHASE7_SCORER_VERSION,
  MEMORY_PHASE7_SUITE_VERSION
} from "../../../evaluation/memory/phase7";
import type { MemoryExecutionAuthorityDependencies } from "./authority";

function verifyCodeOwnedQualification(payload: string, signature: string): boolean {
  if (!MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY) return false;
  try {
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      {
        format: "der",
        key: Buffer.from(MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY, "base64"),
        type: "spki"
      },
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

/** A missing, malformed, expired, or deployment-stale code-owned registry
 * remains fail-closed at both capability projection and execution admission. */
export const defaultMemoryExecutionAuthority = Object.freeze({
  qualification: {
    corpusHash: MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
    corpusVersion: MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
    identitiesByRole: {
      MEMORY_PROFILE: {
        corpusHash: MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
        corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
        scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
        suiteVersion: MEMORY_PHASE7_SUITE_VERSION
      },
      MEMORY_QUERY_EXPAND: {
        corpusHash: MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
        corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
        scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
        suiteVersion: MEMORY_PHASE7_SUITE_VERSION
      },
      MEMORY_RERANK: {
        corpusHash: MEMORY_PHASE7_HOLDOUT_CORPUS_HASH,
        corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
        scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
        suiteVersion: MEMORY_PHASE7_SUITE_VERSION
      }
    },
    registry: MEMORY_CAPABILITY_QUALIFICATION_REGISTRY,
    scorerVersion: MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
    suiteVersion: MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION,
    verifySignature: verifyCodeOwnedQualification
  }
}) satisfies MemoryExecutionAuthorityDependencies;
