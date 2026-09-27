import type { PrismaClient } from "@prisma/client";

export type MemoryRunPresentationStatus = "INPUT_TOO_LONG" | "LIMITED" | "UNAVAILABLE";

type MemoryRunProjectionClient = Pick<
  PrismaClient,
  "memoryRetrievalAttempt" | "modelRun" | "modelRunMemoryBinding"
>;

/**
 * Projects only the user-facing consequence of a committed retrieval receipt.
 * A degraded non-empty binding contributed Memory under explicit limitations;
 * failed-safe means no Memory context was admitted. A turn Memory could not
 * process in full is reported as too long, whatever context it received.
 * Internal reason codes, settings snapshots, and identifiers stay server-side.
 */
export async function loadMemoryRunPresentationStatuses(
  client: MemoryRunProjectionClient,
  input: Readonly<{
    runIds: readonly string[];
    userId: string;
  }>
): Promise<ReadonlyMap<string, MemoryRunPresentationStatus>> {
  const runIds = [...new Set(input.runIds.filter(Boolean))];
  if (runIds.length === 0) return new Map();

  const personalRunIds = await client.modelRun.findMany({
      select: { id: true },
      where: {
        chat: {
          memoryMode: { not: "TEMPORARY" },
          projectId: null
        },
        id: { in: runIds },
        userId: input.userId
      }
    });
  if (personalRunIds.length === 0) return new Map();

  const bindings = await client.modelRunMemoryBinding.findMany({
    select: { modelRunId: true, outcome: true, retrievalAttemptId: true },
    where: {
      modelRunId: { in: personalRunIds.map(({ id }) => id) },
      userId: input.userId
    }
  });
  const tooLongAttempts = bindings.length === 0
    ? []
    : await client.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: {
          budgetSnapshot: { equals: true, path: ["memoryInputTooLong"] },
          id: { in: bindings.map(({ retrievalAttemptId }) => retrievalAttemptId) },
          userId: input.userId
        }
      });
  const tooLong = new Set(tooLongAttempts.map(({ id }) => id));

  return new Map(bindings.flatMap((binding): Array<
    readonly [string, MemoryRunPresentationStatus]
  > => {
    if (tooLong.has(binding.retrievalAttemptId)) {
      return [[binding.modelRunId, "INPUT_TOO_LONG"]];
    }
    if (binding.outcome === "DEGRADED") return [[binding.modelRunId, "LIMITED"]];
    if (binding.outcome === "FAILED_SAFE") return [[binding.modelRunId, "UNAVAILABLE"]];
    return [];
  }));
}
