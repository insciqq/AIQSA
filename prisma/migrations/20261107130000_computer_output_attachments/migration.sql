-- A file the agent attaches to its answer from the user's computer (AIQSA
-- Connect, `computer_attach_file`): an ordinary chat attachment of the run's
-- answer, stored in private object storage and released or deleted with its
-- branch and chat like a Workspace output (lib/server/connect/computerOutputs.ts).
-- Expand only: the previous release's writers never name the value. An earlier
-- image cannot read an answer that holds such a file, so going back after a
-- computer file was attached means restoring the backup taken before the upgrade.
ALTER TYPE "AttachmentOrigin" ADD VALUE 'COMPUTER_OUTPUT';
