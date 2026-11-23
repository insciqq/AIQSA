import { Prisma } from "@prisma/client";
import { MEMORY_SWITCH_DEFAULTS } from "../../../contracts/memoryNote";

/**
 * Whose passages may go to the past-chat embedding model: an active account with Memory and past-chat search on, as
 * the old Memory indexed and embedded history only for such owners. Every other owner's chats are still indexed by
 * words, which stays in the installation, so turning a switch off keeps the passages and stops the searches
 * (`agent_docs/MEMORY.md`); nothing is sent for them until the switch is on again, when the backfill's vectors sweep
 * (`./backfill.ts`) marks their chats within a minute. The pass asks right before each embedding call (`./pass.ts`), so
 * a switch turned off while a chat is being embedded stops the requests that follow.
 */

/** The note a chat settles with when its words are indexed and its owner does not allow vectors now. */
export const CHAT_SEARCH_OWNER_OFF_NOTE = "owner_search_off";

/** The rule as a raw SQL predicate on an owner id (a column or a value), for the sweep and the store. */
export function chatSearchOwnerEmbeddingSql(userId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "User" AS embedding_owner
    LEFT JOIN "UserSettings" AS embedding_settings ON embedding_settings."userId" = embedding_owner."id"
    WHERE embedding_owner."id" = ${userId}
      AND embedding_owner."status" = 'active'::"UserStatus"
      AND COALESCE(embedding_settings."memoryEnabled", ${MEMORY_SWITCH_DEFAULTS.memoryEnabled})
      AND COALESCE(embedding_settings."pastChatSearchEnabled", ${MEMORY_SWITCH_DEFAULTS.pastChatSearchEnabled})
  )`;
}
