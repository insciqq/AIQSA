import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobHandler } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import {
  memoryRebuildJobClaimIsValid,
  parseMemoryRebuildJobFingerprint
} from "./contract";
import {
  createPrismaMemoryRebuildRepository,
  type MemoryRebuildRepository
} from "./repository";

export function createMemoryRebuildHandler(
  repository: MemoryRebuildRepository
): MemoryJobHandler {
  return Object.freeze({
    kind: "REBUILD_INDEX" as const,

    async preflight(job) {
      if (!memoryRebuildJobClaimIsValid(job)) {
        return { errorCode: "memory_rebuild_job_invalid", status: "CANCELLED" };
      }
      const status = await repository.status(job.userId, job.id);
      if (!status) {
        return { errorCode: "memory_rebuild_not_found", status: "STALE" };
      }
      if (status.state === "CANCELLED") {
        return { errorCode: "memory_rebuild_cancelled", status: "CANCELLED" };
      }
      if (status.state === "STALE") {
        return { errorCode: "memory_source_stale", status: "STALE" };
      }
      if (status.state === "FAILED") {
        return {
          errorCode: status.errorCode ?? "memory_rebuild_failed",
          status: "CANCELLED"
        };
      }
      return { status: "READY" };
    },

    async execute(claim, context) {
      if (!memoryRebuildJobClaimIsValid(claim)) {
        throw new MemoryCoordinatorError("memory_rebuild_job_invalid", false);
      }
      const identity = parseMemoryRebuildJobFingerprint(
        claim.idempotencyFingerprint
      );
      if (!identity) {
        throw new MemoryCoordinatorError("memory_rebuild_job_invalid", false);
      }
      await context.setStage("catching_up");
      return {
        acceptedResultHash: memorySha256({
          identity,
          jobId: claim.id,
          pipelineVersion: claim.pipelineVersion,
          version: "v1"
        }),
        apply: (tx, committedClaim) => repository.applyJob(
          tx,
          committedClaim,
          context.now()
        ),
        stage: "catching_up"
      };
    }
  });
}

export function createPrismaMemoryRebuildHandler(
  client: PrismaClient = prisma
): MemoryJobHandler {
  return createMemoryRebuildHandler(createPrismaMemoryRebuildRepository(client));
}
