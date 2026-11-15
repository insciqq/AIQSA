-- Telegram buttons for the changes an answer made to the user's own
-- resources: Undo, and Confirm or Cancel of a proposal to delete, share or
-- publish (lib/server/telegram/changes/). Only this release writes them;
-- added values change no existing row.
ALTER TYPE "TelegramCallbackKind" ADD VALUE 'change_undo';
ALTER TYPE "TelegramCallbackKind" ADD VALUE 'change_confirm';
ALTER TYPE "TelegramCallbackKind" ADD VALUE 'change_cancel';
