import type { KnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";

/** Each clarified question starts after the preceding durable attempts. It
 * cannot replay their results or replenish the accepted operation budget. */
export function knowledgeLifecycleAfterFollowup(
  lifecycle: KnowledgeProviderDispatchLifecycle, offset: number
): KnowledgeProviderDispatchLifecycle {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 8) throw new Error("knowledge_answer_operation_budget_exceeded");
  if (offset === 0) return lifecycle;
  const ordinal = (value: number) => {
    if (value + offset > 8) throw new Error("knowledge_answer_operation_budget_exceeded");
    return value + offset;
  };
  return {
    ...lifecycle,
    inspect: input => lifecycle.inspect({ ...input, ordinal: ordinal(input.ordinal) }),
    prepare: input => lifecycle.prepare({ ...input, ordinal: ordinal(input.ordinal) }),
    recover: input => lifecycle.recover({ ...input, ordinal: ordinal(input.ordinal) })
  };
}
