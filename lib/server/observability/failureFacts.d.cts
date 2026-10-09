import type { DatabaseFailureKind } from "./events";

/** The content-free facts of a caught value's cause chain. */
export type FailureFacts = Readonly<{
  prisma_code?: string; sqlstate?: string; db_failure?: DatabaseFailureKind;
  tx_timeout_ms?: number; tx_elapsed_ms?: number;
  sys_code?: string; syscall?: string;
  cause_class?: string; cause_site?: string;
}>;
export const FAILURE_SYSCALLS: readonly string[];
export function describeFailureFacts(value: unknown): FailureFacts;
/** Gives a wrapper that must not keep its cause the facts of that cause. */
export function retainFailureCause(wrapper: unknown, cause: unknown): void;
