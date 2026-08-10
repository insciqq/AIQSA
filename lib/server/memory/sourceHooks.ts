import {
  NOOP_MEMORY_SOURCE_MUTATION_HOOKS,
  type MemorySourceMutationHooks
} from "./sourceState";

/**
 * Feature-local Memory leaves compose here. Shared chat/message/run repositories
 * depend only on the narrow hook contract and never import lifecycle owners.
 */
export const defaultMemorySourceMutationHooks: MemorySourceMutationHooks =
  NOOP_MEMORY_SOURCE_MUTATION_HOOKS;
