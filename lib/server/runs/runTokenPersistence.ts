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

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  async function persistPending(): Promise<void> {
    clearFlushTimer();
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
    flush,
    push(delta: string): Promise<void> {
      if (flushError) {
        return Promise.reject(flushError);
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
