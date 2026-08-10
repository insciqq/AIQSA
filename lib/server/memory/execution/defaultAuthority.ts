import {
  MEMORY_CAPABILITY_QUALIFICATION_REGISTRY
} from "../../../evaluation/memory/qualification";
import { MEMORY_EVALUATION_SCORER_VERSION } from "../../../evaluation/memory/contracts";
import type { MemoryExecutionAuthorityDependencies } from "./authority";

/** Production stays fail-closed until an operator-approved signed Memory
 * qualification authority replaces this code-owned empty authority. */
export const defaultMemoryExecutionAuthority = Object.freeze({
  qualification: {
    corpusHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    corpusVersion: "memory-qualification-registry-v1",
    registry: MEMORY_CAPABILITY_QUALIFICATION_REGISTRY,
    scorerVersion: MEMORY_EVALUATION_SCORER_VERSION,
    suiteVersion: "memory-explicit-phase2-v1",
    verifySignature: () => false
  }
}) satisfies MemoryExecutionAuthorityDependencies;
