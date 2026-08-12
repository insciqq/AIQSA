import type { MemoryDeletionOperation, Prisma } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryDeletionHandler } from "../coordinator/types";
import type { MemoryPurgeTarget } from "./contract";
import { parseMemoryPurgeTarget } from "./contract";

export type MemoryDeletionContributor = Readonly<{
  audit: (tx: Prisma.TransactionClient, target: MemoryPurgeTarget) => Promise<number>;
  id: string;
  purge: (tx: Prisma.TransactionClient, target: MemoryPurgeTarget) => Promise<void>;
  version: string;
}>;

export type MemoryDeletionContributorRequirement = Readonly<{
  id: string;
  version: string;
}>;

export type MemoryDeletionProgress = Readonly<{
  complete: boolean;
  completedUnits: number;
  missingContributors: readonly string[];
  totalUnits: number;
}>;

const contributorPartPattern = /^[a-z][a-z0-9._-]{0,63}$/u;

function validateRequirement(requirement: MemoryDeletionContributorRequirement): void {
  if (
    !contributorPartPattern.test(requirement.id) ||
    !contributorPartPattern.test(requirement.version)
  ) {
    throw new Error("memory_deletion_contributor_requirement_invalid");
  }
}

export class MemoryDeletionContributorRegistry {
  readonly #contributors = new Map<string, MemoryDeletionContributor>();
  readonly #operation: MemoryDeletionOperation;
  readonly #requirements: readonly MemoryDeletionContributorRequirement[];

  constructor(input: Readonly<{
    operation: MemoryDeletionOperation;
    requirements: readonly MemoryDeletionContributorRequirement[];
  }>) {
    if (input.requirements.length === 0) {
      throw new Error("memory_deletion_contributors_required");
    }
    const ids = new Set<string>();
    for (const requirement of input.requirements) {
      validateRequirement(requirement);
      if (ids.has(requirement.id)) {
        throw new Error("memory_deletion_contributor_requirement_duplicate");
      }
      ids.add(requirement.id);
    }
    this.#operation = input.operation;
    this.#requirements = Object.freeze(input.requirements.map((requirement) =>
      Object.freeze({ ...requirement })));
  }

  register(contributor: MemoryDeletionContributor): () => void {
    const requirement = this.#requirements.find(({ id }) => id === contributor.id);
    if (!requirement || requirement.version !== contributor.version) {
      throw new Error("memory_deletion_contributor_version_unexpected");
    }
    if (this.#contributors.has(contributor.id)) {
      throw new Error("memory_deletion_contributor_duplicate");
    }
    const frozen = Object.freeze(contributor);
    this.#contributors.set(contributor.id, frozen);
    return () => {
      if (this.#contributors.get(contributor.id) === frozen) {
        this.#contributors.delete(contributor.id);
      }
    };
  }

  missingContributors(): readonly string[] {
    return Object.freeze(this.#requirements
      .filter(({ id }) => !this.#contributors.has(id))
      .map(({ id }) => id));
  }

  totalUnits(): number {
    return this.#requirements.length;
  }

  async inspect(
    tx: Prisma.TransactionClient,
    target: MemoryPurgeTarget
  ): Promise<MemoryDeletionProgress> {
    if (target.kind === "AUTOMATIC_SET" || target.kind === "ALL_REUSABLE") {
      const barrier = await tx.memorySourceBarrier.findFirst({
        select: { id: true },
        where: {
          id: target.targetId,
          kind: target.kind === "ALL_REUSABLE" ? "ALL_REUSABLE" : "AUTOMATIC_FACTS",
          userId: target.userId
        }
      });
      if (!barrier) {
        throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
      }
    }
    const missing = this.missingContributors();
    let completedUnits = 0;
    for (const requirement of this.#requirements) {
      const contributor = this.#contributors.get(requirement.id);
      if (!contributor) continue;
      const remaining = await contributor.audit(tx, target);
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw new MemoryCoordinatorError("memory_purge_audit_invalid", true);
      }
      if (remaining === 0) completedUnits += 1;
    }
    return {
      complete: missing.length === 0 && completedUnits === this.#requirements.length,
      completedUnits,
      missingContributors: missing,
      totalUnits: this.#requirements.length
    };
  }

  handler(): MemoryDeletionHandler {
    return Object.freeze({
      execute: async (claim) => {
        const target = parseMemoryPurgeTarget(claim);
        if (!target) {
          throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
        }
        if (this.missingContributors().length > 0) {
          throw new MemoryCoordinatorError("memory_deletion_handler_unavailable", true);
        }
        return {
          apply: async (tx) => {
            for (const requirement of this.#requirements) {
              const contributor = this.#contributors.get(requirement.id);
              if (!contributor) {
                throw new MemoryCoordinatorError(
                  "memory_deletion_handler_unavailable",
                  true
                );
              }
              await contributor.purge(tx, target);
            }
            const progress = await this.inspect(tx, target);
            if (!progress.complete) {
              throw new MemoryCoordinatorError("memory_purge_incomplete", true);
            }
          }
        };
      },
      operation: this.#operation
    });
  }
}
