import type { MemoryDeletionOperation, MemoryJobKind } from "@prisma/client";
import type { MemoryDeletionHandler, MemoryJobHandler } from "./types";

export class MemoryCoordinatorRegistry {
  readonly #deletionHandlers = new Map<MemoryDeletionOperation, MemoryDeletionHandler>();
  readonly #jobHandlers = new Map<MemoryJobKind, MemoryJobHandler>();

  registerJob(handler: MemoryJobHandler): () => void {
    if (this.#jobHandlers.has(handler.kind)) {
      throw new Error("memory_job_handler_duplicate");
    }
    this.#jobHandlers.set(handler.kind, Object.freeze(handler));
    return () => {
      if (this.#jobHandlers.get(handler.kind) === handler) {
        this.#jobHandlers.delete(handler.kind);
      }
    };
  }

  registerDeletion(handler: MemoryDeletionHandler): () => void {
    if (this.#deletionHandlers.has(handler.operation)) {
      throw new Error("memory_deletion_handler_duplicate");
    }
    this.#deletionHandlers.set(handler.operation, Object.freeze(handler));
    return () => {
      if (this.#deletionHandlers.get(handler.operation) === handler) {
        this.#deletionHandlers.delete(handler.operation);
      }
    };
  }

  jobHandler(kind: MemoryJobKind): MemoryJobHandler | null {
    return this.#jobHandlers.get(kind) ?? null;
  }

  deletionHandler(operation: MemoryDeletionOperation): MemoryDeletionHandler | null {
    return this.#deletionHandlers.get(operation) ?? null;
  }

  jobKinds(): readonly MemoryJobKind[] {
    return Object.freeze([...this.#jobHandlers.keys()]);
  }

  deletionOperations(): readonly MemoryDeletionOperation[] {
    return Object.freeze([...this.#deletionHandlers.keys()]);
  }
}

export const defaultMemoryCoordinatorRegistry = new MemoryCoordinatorRegistry();
