import { PrismaClient } from "@prisma/client";
import { createPrismaMemorySettingsRepository } from "../../../lib/server/memory/persistence/settings";

/**
 * Run by `snapshotComposerDefaults` as its own `tsx` process: the settings
 * repository's import graph does not load inside the Playwright runner.
 * Arguments: the user id and the toggles to restore, as JSON.
 */
async function main(): Promise<void> {
  const [userId, json] = process.argv.slice(2);
  if (!userId || !json) throw new Error("usage: restoreMemoryToggles.ts <userId> <toggles JSON>");
  const memory = JSON.parse(json) as Readonly<{ learnAutomatically: boolean; referenceChatHistory: boolean; useMemoryFacts: boolean }>;
  const prisma = new PrismaClient();
  try {
    const settings = createPrismaMemorySettingsRepository(prisma);
    const current = await settings.get(userId);
    if (current.learnAutomatically === memory.learnAutomatically && current.referenceChatHistory === memory.referenceChatHistory &&
      current.useMemoryFacts === memory.useMemoryFacts) return;
    // Unchanged toggles in the patch open or close nothing.
    await settings.patch(userId, {
      expectedMemoryRevision: current.memoryRevision, expectedSettingsRevision: current.settingsRevision,
      learnAutomatically: memory.learnAutomatically, referenceChatHistory: memory.referenceChatHistory, useMemoryFacts: memory.useMemoryFacts
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "memory_toggles_restore_failed");
  process.exitCode = 1;
});
