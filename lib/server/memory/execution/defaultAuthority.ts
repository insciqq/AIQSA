import type { MemoryExecutionAuthorityDependencies } from "./authority";

/** Runtime authority is provider/model compatibility plus destination consent.
 * Model-quality registries and installation benchmark allowlists are not part
 * of normal execution admission. */
export const defaultMemoryExecutionAuthority = Object.freeze({
  qualification: Object.freeze({})
}) satisfies MemoryExecutionAuthorityDependencies;
