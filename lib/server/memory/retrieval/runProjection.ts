import type { PrismaClient } from "@prisma/client";

export type MemoryRunPresentationStatus = "LIMITED" | "UNAVAILABLE";

type MemoryRunProjectionClient = Pick<PrismaClient, "modelRun" | "modelRunMemoryBinding">;

/**
 * Projects only the user-facing consequence of a committed retrieval receipt.
 * A degraded non-empty binding contributed Memory under explicit limitations;
 * failed-safe means no Memory context was admitted. Internal reason codes,
 * settings snapshots, and identifiers stay server-side.
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
    select: { modelRunId: true, outcome: true },
    where: {
      modelRunId: { in: personalRunIds.map(({ id }) => id) },
      outcome: { in: ["DEGRADED", "FAILED_SAFE"] },
      userId: input.userId
    }
  });

  return new Map(bindings.map((binding) => [
    binding.modelRunId,
    binding.outcome === "DEGRADED" ? "LIMITED" : "UNAVAILABLE"
  ]));
}
