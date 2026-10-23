import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../lib/domain/modelRunEvents";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import { createNativeRunStore } from "../../lib/server/engine/runStore";
import { createPrismaRunToolLoopOperations } from "../../lib/server/runs/prismaRepositoryToolLoop";
import type { RunOutputArtifactEvent } from "../../lib/server/runs/runOutputEvents";
import type { RunUsageAttribution } from "../../lib/server/runs/runRepositoryContract";

export type NativeRunCompletion = Readonly<{
  assistantMessageId: string;
  chatId: string;
  estimatedCostMicros?: number | null;
  finalText: string;
  /** The follow-up revision the answer saw; 0 when the run admitted none. */
  followupRevision?: number;
  modelId: string;
  outputEvents?: readonly RunOutputArtifactEvent[];
  provider: string;
  runId: string;
  usage?: ModelRunUsage;
  userId: string;
}>;

/**
 * Finishes an admitted run the way the agent engine does (`lib/server/engine/execution.ts`):
 * output events while it runs, the answer published, the run completed, then
 * the provider-reported usage. False when the answer could not be published
 * or the run could not complete (cancelled, already terminal, another engine's).
 */
export async function completeNativeRun(client: PrismaClient, input: NativeRunCompletion): Promise<boolean> {
  const scope = { assistantMessageId: input.assistantMessageId, chatId: input.chatId, runId: input.runId, userId: input.userId };
  const store = createNativeRunStore(client);
  const outputs = createPrismaRunToolLoopOperations(client);
  for (const event of input.outputEvents ?? []) await outputs.appendRunOutputEvent(input.runId, event);
  if (!(await store.publishAnswer(scope, { followupRevision: input.followupRevision ?? 0, text: input.finalText }))) return false;
  if (!(await store.complete(scope))) return false;
  if (input.usage) {
    const attribution: RunUsageAttribution = { estimatedCostMicros: input.estimatedCostMicros ?? null, modelId: input.modelId,
      operationCount: 1, provider: input.provider, purpose: "chat_answer", usage: normalizeTokenUsage(input.usage) };
    await store.writeUsageRows(scope, [{ attribution, key: "0" }]);
    await store.applyUsageTotals(scope, [attribution]);
  }
  return true;
}
