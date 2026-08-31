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
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message)) {
    return error.message;
  }
  return "memory_search_worker_failed";
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function log(event: string, value: Readonly<Record<string, unknown>>): void {
  console.info(JSON.stringify({ event, ...value }));
}

async function main(): Promise<void> {
  if (retryBlocked) {
    const retried = await store.retryBlocked({ limit: 1_000, now: new Date() });
    log("memory_lexical_projection_retry_blocked", { retried });
    return;
  }
  if (integrityOnly) {
    const audit = await auditMemoryLexicalProjection({
      configuration: configuration.worker,
      openSearchConfiguration: configuration.openSearch,
      search,
      store
    });
    log("memory_lexical_projection_integrity", audit);
    if (audit.mismatchedGenerations > 0 ||
      audit.integrity.blockedEvents > 0 ||
      audit.integrity.claimedEvents > 0 ||
      audit.integrity.degradedGenerations > 0 ||
      audit.integrity.outstandingEvents > 0 ||
      audit.integrity.readyGenerations + audit.integrity.retiredGenerations !==
        audit.integrity.totalGenerations) {
      throw new Error("memory_lexical_projection_integrity_failed");
    }
    return;
  }
  if (rebuild) {
    const result = await rebuildMemoryLexicalProjection({
      configuration: configuration.worker,
      openSearchConfiguration: configuration.openSearch,
      search,
      store
    });
    log("memory_lexical_projection_rebuild", result);
    if (result.failed > 0 || result.integrity.blockedEvents > 0 ||
      result.integrity.claimedEvents > 0 ||
      result.integrity.degradedGenerations > 0 ||
      result.integrity.outstandingEvents > 0 ||
      result.integrity.readyGenerations + result.integrity.retiredGenerations !==
        result.integrity.totalGenerations) {
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
      log("memory_lexical_projection_pass", pass);
      deferredVerificationPasses =
        nextMemoryLexicalProjectionDeferredVerificationPasses(
          deferredVerificationPasses,
          pass.claimed
        );
      if (once || drain && pass.claimed === 0 || stopping) {
        if (drain) {
          const integrity = await store.inspect();
          log("memory_lexical_projection_drain_integrity", integrity);
          if (integrity.blockedEvents > 0 || integrity.claimedEvents > 0 ||
            integrity.degradedGenerations > 0 || integrity.outstandingEvents > 0) {
            throw new Error("memory_lexical_projection_drain_incomplete");
          }
        }
        return;
      }
      if (pass.claimed > 0) continue;
    } catch (error) {
      const code = safeErrorCode(error);
      log("memory_lexical_projection_pass_failed", { code });
      if (once || drain) throw error;
    }
    await wait(configuration.worker.intervalMs);
  } while (!stopping);
}

main()
  .catch((error: unknown) => {
    console.error(safeErrorCode(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
