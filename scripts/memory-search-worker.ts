import "./worker-bootstrap.cjs";
import { logEvent, reportSubsystemFailure, reportSubsystemHealthy } from "../lib/server/observability";
import { PrismaClient } from "@prisma/client";
import {
  createPrismaMemoryLexicalProjectionStore
} from "../lib/server/memory/searchProjection/repository";
import {
  auditMemoryLexicalProjection,
  memoryLexicalProjectionRuntimeConfigurationFromEnv,
  nextMemoryLexicalProjectionDeferredVerificationPasses,
  rebuildMemoryLexicalProjection,
  runMemoryLexicalProjectionPass,
  shouldRunMemoryLexicalProjectionMaintenance
} from "../lib/server/memory/searchProjection/worker";
import { OpenSearchTransportError } from
  "../lib/server/search/opensearch/coreTransport";
import { createMemoryOpenSearchClient } from
  "../lib/server/search/opensearch/memoryClient";

const allowedArguments = new Set([
  "--drain", "--integrity", "--once", "--rebuild", "--retry-blocked"
]);
if (process.argv.slice(2).some((argument) => !allowedArguments.has(argument))) {
  throw new Error("memory_search_worker_argument_invalid");
}
const once = process.argv.includes("--once");
const drain = process.argv.includes("--drain");
const rebuild = process.argv.includes("--rebuild");
const integrityOnly = process.argv.includes("--integrity");
const retryBlocked = process.argv.includes("--retry-blocked");
if ([rebuild, integrityOnly, retryBlocked].filter(Boolean).length > 1 ||
  rebuild && once || integrityOnly && (once || drain) ||
  retryBlocked && (once || drain)) {
  throw new Error("memory_search_worker_argument_invalid");
}

const prisma = new PrismaClient();
const store = createPrismaMemoryLexicalProjectionStore(prisma);
const search = createMemoryOpenSearchClient();
const configuration = memoryLexicalProjectionRuntimeConfigurationFromEnv();
let stopping = false;
let deferredVerificationPasses = 0;
let indexValidated = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}

function safeErrorCode(error: unknown): string {
  if (error instanceof OpenSearchTransportError) return error.code;
  return "memory_search_worker_failed";
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  if (retryBlocked) {
    const retried = await store.retryBlocked({ limit: 1_000, now: new Date() });
    logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "retry", outcome: "completed", count: retried });
    return;
  }
  if (integrityOnly) {
    const audit = await auditMemoryLexicalProjection({
      configuration: configuration.worker,
      openSearchConfiguration: configuration.openSearch,
      search,
      store
    });
    if (audit.mismatchedGenerations > 0 ||
      audit.integrity.blockedEvents > 0 ||
      audit.integrity.claimedEvents > 0 ||
      audit.integrity.degradedGenerations > 0 ||
      audit.integrity.outstandingEvents > 0 ||
      audit.integrity.readyGenerations + audit.integrity.retiredGenerations !==
        audit.integrity.totalGenerations) {
      logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "integrity", outcome: "failed", code: "memory_lexical_projection_integrity_failed", count: audit.mismatchedGenerations, pending_count: audit.integrity.outstandingEvents });
      throw new Error("memory_lexical_projection_integrity_failed");
    }
    logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "integrity", outcome: "completed", count: audit.checkedGenerations });
    return;
  }
  if (rebuild) {
    const result = await rebuildMemoryLexicalProjection({
      configuration: configuration.worker,
      openSearchConfiguration: configuration.openSearch,
      search,
      store
    });
    logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "rebuild", outcome: result.failed > 0 ? "failed" : "completed", failed_count: result.failed, completed_count: result.projected });
    if (result.failed > 0 || result.integrity.blockedEvents > 0 ||
      result.integrity.claimedEvents > 0 ||
      result.integrity.degradedGenerations > 0 ||
      result.integrity.outstandingEvents > 0 ||
      result.integrity.readyGenerations + result.integrity.retiredGenerations !==
        result.integrity.totalGenerations) {
      logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "integrity", outcome: "failed", code: "memory_lexical_projection_rebuild_failed", pending_count: result.integrity.outstandingEvents });
      throw new Error("memory_lexical_projection_rebuild_failed");
    }
    return;
  }

  do {
    try {
      const runMaintenance = shouldRunMemoryLexicalProjectionMaintenance(
        indexValidated,
        deferredVerificationPasses
      );
      const pass = await runMemoryLexicalProjectionPass({
        configuration: configuration.worker,
        deferVerification: !runMaintenance,
        openSearchConfiguration: configuration.openSearch,
        search,
        skipIndexValidation: !runMaintenance,
        store
      });
      indexValidated = true;
      if (pass.failed === 0) reportSubsystemHealthy("memory_search", "projection");
      if (pass.claimed > 0 || pass.failed > 0) {
        logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "projection",
          outcome: pass.failed > 0 ? "failed" : "completed", claimed_count: pass.claimed,
          failed_count: pass.failed, completed_count: pass.projected });
      }
      if (pass.integrityFailed > 0) {
        reportSubsystemFailure({ subsystem: "memory_search", stage: "integrity", code: "memory_lexical_projection_integrity_failed", action: "degrade" });
      } else if (runMaintenance) {
        reportSubsystemHealthy("memory_search", "integrity");
      }
      deferredVerificationPasses =
        nextMemoryLexicalProjectionDeferredVerificationPasses(
          deferredVerificationPasses,
          pass.claimed
        );
      if (once || drain && pass.claimed === 0 || stopping) {
        if (drain) {
          const integrity = await store.inspect();
          if (integrity.blockedEvents > 0 || integrity.claimedEvents > 0 ||
            integrity.degradedGenerations > 0 || integrity.outstandingEvents > 0) {
            logEvent("runtime_lifecycle", { subsystem: "memory_search", stage: "integrity", outcome: "failed", code: "memory_lexical_projection_drain_incomplete", pending_count: integrity.outstandingEvents });
            throw new Error("memory_lexical_projection_drain_incomplete");
          }
        }
        return;
      }
      if (pass.claimed > 0) continue;
    } catch (error) {
      const code = safeErrorCode(error);
      reportSubsystemFailure({ subsystem: "memory_search", stage: "projection", code, action: once || drain ? "stop" : "retry" });
      if (once || drain) throw error;
    }
    await wait(configuration.worker.intervalMs);
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    reportSubsystemFailure({ subsystem: "memory_search", stage: "shutdown", code: safeErrorCode(error), action: "stop" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
