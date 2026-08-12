import type { Prisma } from "@prisma/client";

export type AccountMemoryDeletionAdvance = Readonly<{
  admitted: boolean;
  readyForUserDeletion: boolean;
}>;

export type AccountMemoryDeletionHook = Readonly<{
  advance: (
    tx: Prisma.TransactionClient,
    input: Readonly<{ now: Date; userId: string }>
  ) => Promise<AccountMemoryDeletionAdvance>;
  kick: () => void;
}>;

export class AccountMemoryDeletionRegistry {
  #hook: AccountMemoryDeletionHook | null = null;

  current(): AccountMemoryDeletionHook | null {
    return this.#hook;
  }

  register(hook: AccountMemoryDeletionHook): () => void {
    if (this.#hook) throw new Error("memory_account_deletion_hook_duplicate");
    this.#hook = Object.freeze(hook);
    return () => {
      if (this.#hook === hook) this.#hook = null;
    };
  }
}

/** Intentionally empty until the sole Phase 8 composition gate registers it. */
export const defaultAccountMemoryDeletionRegistry =
  new AccountMemoryDeletionRegistry();
