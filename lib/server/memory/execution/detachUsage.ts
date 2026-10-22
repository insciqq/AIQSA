import type { Prisma } from "@prisma/client";

/** Content-free accounting survives the deletion of its Memory execution. */
export async function detachMemoryExecutionUsage(
  tx: Prisma.TransactionClient,
  input: Readonly<{ executionBindingIds: readonly string[]; userId: string }>
): Promise<void> {
  if (input.executionBindingIds.length === 0) return;
  await tx.usageEvent.updateMany({
    data: { memoryExecutionBindingId: null, providerModelId: null },
    where: {
      memoryExecutionBindingId: { in: [...input.executionBindingIds] },
      userId: input.userId
    }
  });
}
