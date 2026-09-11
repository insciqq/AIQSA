import type { MemoryExecutionAuthorityDependencies } from "./authority";

/** Runtime authority is the configured exact provider/model and role compatibility.
 * Model-quality registries and installation benchmark allowlists are not part
 * of normal execution admission. */
export const defaultMemoryExecutionAuthority = Object.freeze({}) satisfies
  MemoryExecutionAuthorityDependencies;
