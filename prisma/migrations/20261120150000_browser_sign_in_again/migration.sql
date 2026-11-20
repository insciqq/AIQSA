-- Sign in again (2026-11-20): a user turn the server writes when the owner
-- presses Sign in again for one site (`lib/contracts/browserSignIn.ts`), and
-- the host a `browser_sign_in_required` occurrence failed on, which that
-- button opens. Expand only: the previous release's writers never name the
-- value or the column. An earlier image cannot read a message of the new kind,
-- so going back after one was sent means restoring the backup taken before the
-- upgrade.
ALTER TYPE "MessageSystemTurnKind" ADD VALUE 'browser_sign_in_request' AFTER 'subagent_callback';

ALTER TABLE "ScheduledTaskOccurrence" ADD COLUMN "signInHost" VARCHAR(253);
