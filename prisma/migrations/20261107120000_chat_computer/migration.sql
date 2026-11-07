-- The owner's last computer choice for a chat (AIQSA Connect): one of their
-- devices and the folder its commands start in. Expand only: the previous
-- release's writers never name these columns, so its chats keep none.
-- No foreign key to "ConnectDevice": a removed or revoked device stays named,
-- so the chat can show it as removed rather than silently dropping the choice;
-- admission checks the device's owner on every message.
ALTER TABLE "Chat" ADD COLUMN "computerDeviceId" TEXT;
ALTER TABLE "Chat" ADD COLUMN "computerCwd" TEXT;
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_computer_pair_check"
  CHECK (("computerDeviceId" IS NULL) = ("computerCwd" IS NULL));
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_computerDeviceId_check"
  CHECK ("computerDeviceId" IS NULL OR "computerDeviceId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_computerCwd_check"
  CHECK ("computerCwd" IS NULL OR (char_length("computerCwd") BETWEEN 1 AND 1024
    AND btrim("computerCwd") <> '' AND "computerCwd" !~ '[\x01-\x1f\x7f-\x9f]'));
