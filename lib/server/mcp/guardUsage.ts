import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { runAttributionUsageRows } from "../runs/prismaRepositoryUsage";
import { logEvent } from "../observability";

// Shared by Next route bundles: code gateway and model calls use the same live ledger.
const KEY = Symbol.for("aiqsa.mcp-guard-usage.v1");
const slot = globalThis as typeof globalThis & { [KEY]?: Map<string, (usage: RunUsageAttribution) => void> };
const ledgers = slot[KEY] ??= new Map();
export function registerMcpGuardUsage(runId: string, add: (usage: RunUsageAttribution) => void): () => void {
  ledgers.set(runId, add);
  return () => { if (ledgers.get(runId) === add) ledgers.delete(runId); };
}

const pause = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_000); timer.unref?.(); });

/** A late gateway response keeps its accounting after the run released its live ledger. */
export async function writeLateMcpGuardUsage(db: Pick<PrismaClient, "modelRun" | "usageEvent">,
  runId: string, attribution: RunUsageAttribution, wait = pause): Promise<void> {
  const id = randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    try {
      let scope = await db.modelRun.findUnique({ where: { id: runId },
        select: { chatId: true, userId: true, status: true, answerCompletedAt: true } });
      // If another route bundle has not registered the ledger yet, answer-first still holds.
      while (scope && !scope.answerCompletedAt && !["complete", "error", "cancelled"].includes(scope.status)) {
        await wait();
        scope = await db.modelRun.findUnique({ where: { id: runId },
          select: { chatId: true, userId: true, status: true, answerCompletedAt: true } });
      }
      if (!scope) return; // Deletion never resurrects a run or its accounting links.
      const row = runAttributionUsageRows({ runId, chatId: scope.chatId, userId: scope.userId }, [{ ...attribution,
        purpose: "mcp_guard", estimatedCostMicros: attribution.costReported ? attribution.estimatedCostMicros : null }])[0]!;
      // A failed local acknowledgement can retry this ID without duplicating provider usage.
      await db.usageEvent.createMany({ data: [{ ...row, id }], skipDuplicates: true });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      await wait();
    }
  }
}

type LateWriter = (runId: string, attribution: RunUsageAttribution) => Promise<void>;
const defaultLateWriter: LateWriter = async (runId, attribution) => {
  const { prisma } = await import("../prisma");
  await writeLateMcpGuardUsage(prisma, runId, attribution);
};

export function createMcpGuardUsageCollector(writeLate: LateWriter = defaultLateWriter) {
  return (runId: string, usage: RunUsageAttribution): void => {
    const add = ledgers.get(runId);
    if (add) { add(usage); return; }
    // Accounting never delays or changes the verdict, including on database failure.
    void Promise.resolve().then(() => writeLate(runId, usage)).catch(() => {
      logEvent("service_operation", { action: "degrade", code: "mcp_guard_usage_unrecorded", outcome: "degraded",
        subsystem: "database", stage: "write", run_id: runId });
    });
  };
}
export const collectMcpGuardUsage = createMcpGuardUsageCollector();
