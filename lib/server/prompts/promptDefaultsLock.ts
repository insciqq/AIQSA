import { Prisma } from "@prisma/client";

type PromptDefaultsLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

// Call the shared/exclusive helpers before settings/chat row locks. Readers share
// the key so independent chat creation and branching stay concurrent.
export function promptDefaultsAdvisoryLockKey(userId: string): string {
  return `aiqsa:prompt-defaults:${userId}`;
}

export async function lockUserPromptDefaultsExclusive(
  tx: PromptDefaultsLockClient,
  userId: string
): Promise<void> {
  const key = promptDefaultsAdvisoryLockKey(userId);
  await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::int AS "locked"
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `;
}

export async function lockUserPromptDefaultsShared(
  tx: PromptDefaultsLockClient,
  userId: string
): Promise<void> {
  const key = promptDefaultsAdvisoryLockKey(userId);
  await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::int AS "locked"
    FROM pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))
  `;
}

export async function lockOwnedPromptPreset(
  tx: PromptDefaultsLockClient,
  input: { promptId: string; userId: string }
): Promise<string | null> {
  const [prompt] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "PromptPreset"
    WHERE "id" = ${input.promptId}
      AND "userId" = ${input.userId}
    FOR KEY SHARE
  `;

  return prompt?.id ?? null;
}
