import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { prisma } from "../prisma";
import { createAcceptedStructuredOutputSnapshotExecutor } from "../providerRuntime/structuredOutputExecutor";
import { buildChatTitleRequest, CHAT_TITLE_GENERATION_TIMEOUT_MS, normalizeGeneratedChatTitle } from "./titleGeneration";
import { createChatTitleRepository } from "./titleGenerationRepository";

export function createChatTitleWorker(input: Readonly<{
  execute: ReturnType<typeof createAcceptedStructuredOutputSnapshotExecutor>;
  repository: ReturnType<typeof createChatTitleRepository>;
}>) {
  return {
    async reconcile(signal: AbortSignal): Promise<void> {
      await input.repository.recover(new Date());
      for (let index = 0; index < 10 && !signal.aborted; index += 1) {
        const work = await input.repository.take(new Date());
        if (work === null) return;
        if (work === "skipped") continue;
        let usage: ModelRunUsage | null = null;
        let title: string | null = null;
        try {
          if (!signal.aborted && await input.repository.isCurrent(work)) {
            const result = await input.execute(work.providerSnapshot, buildChatTitleRequest(work), {
              onUsage: (value) => { usage = mergeTokenUsage(usage ?? {}, value); },
              signal: AbortSignal.any([signal, AbortSignal.timeout(CHAT_TITLE_GENERATION_TIMEOUT_MS)]),
              timeoutMs: CHAT_TITLE_GENERATION_TIMEOUT_MS
            });
            title = normalizeGeneratedChatTitle(result.title);
          }
        } catch {
          if (usage) usage = normalizeTokenUsage({ ...normalizeTokenUsage(usage), completeness: "partial" });
        }
        // Preserve paid accounting even for invalid output, revocation, rename,
        // or failure to apply the title. This operation is independently idempotent.
        if (usage) await input.repository.recordUsage(work, usage);
        await input.repository.finish(work, signal.aborted ? null : title);
      }
    }
  };
}

export function createPrismaChatTitleWorker() {
  return createChatTitleWorker({
    execute: createAcceptedStructuredOutputSnapshotExecutor(prisma, { disableRequestRetries: true }),
    repository: createChatTitleRepository(prisma)
  });
}
