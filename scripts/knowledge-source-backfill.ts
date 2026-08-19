import { prisma } from "../lib/server/prisma";
import {
  backfillV1KnowledgeSources,
  materializeKnowledgeBackfillSnapshots,
  reconcileKnowledgeSourcePersistence
} from "../lib/server/knowledge/sourcePersistence";

function batchSize(args: readonly string[]): number {
  if (args.length === 0) return 100;
  if (args.length !== 1) throw new Error("usage: knowledge-source-backfill [--batch-size=1..1000]");
  const match = /^--batch-size=(\d{1,4})$/u.exec(args[0] ?? "");
  const value = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("usage: knowledge-source-backfill [--batch-size=1..1000]");
  }
  return value;
}

async function main(): Promise<void> {
  const limit = batchSize(process.argv.slice(2));
  let processedDocuments = 0;
  let skippedProfilelessCandidates = 0;
  while (true) {
    const batch = await backfillV1KnowledgeSources({ limit }, prisma);
    processedDocuments += batch.processedDocuments;
    skippedProfilelessCandidates += batch.skippedProfilelessCandidates;
    if (batch.processedDocuments === 0) {
      if (batch.remainingDocuments !== 0) {
        throw new Error("knowledge_source_backfill_stalled");
      }
      break;
    }
  }
  const snapshots = await materializeKnowledgeBackfillSnapshots(prisma);
  const reconciliation = await reconcileKnowledgeSourcePersistence(prisma);
  const complete = reconciliation.discrepancies === 0 &&
    skippedProfilelessCandidates === 0;
  process.stdout.write(`${JSON.stringify({
    processedDocuments,
    reconciliation,
    skippedProfilelessCandidates,
    snapshots,
    status: complete ? "reconciled" : "incomplete"
  })}\n`);
  if (!complete) throw new Error("knowledge_source_reconciliation_incomplete");
}

void main()
  .catch((error: unknown) => {
    const code = error instanceof Error && /^knowledge_[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "knowledge_source_backfill_failed";
    console.error(`AIQSA Knowledge Source reconciliation blocked: ${code}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
