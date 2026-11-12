-- Discord Connect call names: the names that address the bot when a message
-- in a server channel or thread starts with one, then a comma, colon, space or
-- dash. The empty default leaves mentions and Replies as the only ways to ask
-- there; direct messages are always answered.
-- Expand only: previous-release writers never read or write the column.

-- AlterTable
ALTER TABLE "DiscordBotControl" ADD COLUMN "callNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
