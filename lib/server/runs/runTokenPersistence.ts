import type { RunRepository } from "./runRepositoryContract";

const tokenPersistenceFlushIntervalMs = 400;
const tokenPersistenceMaxTokens = 32;

type TokenPersistenceRepository = Pick<RunRepository, "appendAssistantText">;

export function createRunTokenPersistenceBuffer(input: Readonly<{
  allowErroredAssistant?: boolean;
  assistantMessageId: string;
  initialText?: string;
  onPersist?(): void;
  repository: TokenPersistenceRepository;
  runId: string;
}>) {
  let assistantText = input.initialText ?? "";
  let pendingDelta = "";
  let pendingTokenCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let flushError: unknown = null;
  let persistenceDisabled = false;

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  async function persistPending(): Promise<void> {
    clearFlushTimer();
    if (persistenceDisabled) {
      pendingDelta = "";
      pendingTokenCount = 0;
      return;
    }
    if (!pendingDelta) {
      return;
    }

    const text = assistantText;
    pendingDelta = "";
    pendingTokenCount = 0;

    await input.repository.appendAssistantText(
      input.assistantMessageId,
      text,
      {
        ...(input.allowErroredAssistant ? { allowErrored: true } : {}),
        runId: input.runId
      }
    );
    input.onPersist?.();
  }

  function flush(): Promise<void> {
    if (flushError) {
      return Promise.reject(flushError);
    }

    flushChain = flushChain.then(persistPending, persistPending);
    return flushChain.catch((error: unknown) => {
      flushError = error;
      throw error;
    });
  }

  function scheduleFlush(): void {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error: unknown) => {
        flushError = error;
      });
    }, tokenPersistenceFlushIntervalMs);
  }

  return {
    async disablePersistence(): Promise<void> {
      persistenceDisabled = true;
      clearFlushTimer();
      assistantText = "";
      pendingDelta = "";
      pendingTokenCount = 0;
      // Wait until a previously-started flush settles before the repository
      // replaces the message and purges durable provider events. Preserve the
      // original flush error for the normal pipeline failure path, but do not
      // let it bypass the live-only persistence fence.
      await flushChain.catch(() => undefined);
    },
    flush,
    push(delta: string): Promise<void> {
      if (flushError) {
        return Promise.reject(flushError);
      }

      if (persistenceDisabled) {
        return Promise.resolve();
      }

      assistantText += delta;
      pendingDelta += delta;
      pendingTokenCount += 1;

      if (pendingTokenCount >= tokenPersistenceMaxTokens) {
        return flush();
      }

      scheduleFlush();
      return Promise.resolve();
    },
    resetLocal(): void {
      clearFlushTimer();
      assistantText = "";
      pendingDelta = "";
      pendingTokenCount = 0;
    },
    throwIfFailed(): void {
      if (flushError) {
        throw flushError;
      }
    }
  };
}
